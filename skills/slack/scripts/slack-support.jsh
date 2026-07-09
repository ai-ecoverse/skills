// Slack Support Portal client — scrapes a Slack Enterprise support portal.
// Uses the sliccy:browser bridge to interact with the server-rendered support portal.
// Cookie-based auth via existing browser session — no REST API available.
//
// jsh runtime migration (issue #176)
//   • Browser access uses require('sliccy:browser') (findTab / evalAsync) instead
//     of legacy browser shell-outs and eval-file temp files.
//   • Each page script fetches its target page same-origin and parses the
//     server-rendered HTML with DOMParser — no navigation or temp files needed.
//   • Argument parsing uses process.argv.parseFlags() instead of a manual loop.
//
// Follow-up hardening (post-migration review)
//   • The support-portal domain is no longer hardcoded. Resolution order:
//     `--domain=<host>` flag > `skill.config().domain` > built-in default.
//     Set a workspace-specific default with:
//       slack-support config --domain=your-org.enterprise.slack.com
//   • findSupportTab() now opens the portal tab automatically via
//     browser.ensureTab() when no matching tab is already open, instead of
//     erroring out and telling the user to open one by hand (matches the
//     browser.findTab()-then-browser.ensureTab() fallback pattern used in
//     the merged fluffyjaws migration).
//   • Fixed a pre-existing scrape bug in `list`: open/closed status was
//     inferred by walking from each <h2> heading to the "nearest following
//     <table>", which mislabels every row as "open" whenever the account
//     has zero open requests (the generic "Your Help Requests" heading
//     greedily claims the Closed Requests table because no Open Requests
//     heading/table exists to compete with it). Status is now read directly
//     off each row's own `data-js="open-request"|"closed-request"` marker,
//     which every row already carries — no heading inference needed.

const browser = require('sliccy:browser');
const skill = require('sliccy:skill');

const DEFAULT_SUPPORT_DOMAIN = 'adobe-dx-support.enterprise.slack.com';

// Resolved once at startup in Main (see bottom of file) — do not read these
// before resolveSupportDomain() has run.
let SUPPORT_DOMAIN = DEFAULT_SUPPORT_DOMAIN;
let BASE_URL = `https://${SUPPORT_DOMAIN}`;
let REQUESTS_URL = `${BASE_URL}/help/requests`;

async function loadConfig() {
  try {
    return (await skill.config()) || {};
  } catch (_) {
    return {};
  }
}

// --domain=<host> flag wins, then skill.config().domain (persisted via
// `slack-support config --domain=...`), then the built-in default.
async function resolveSupportDomain(flags) {
  if (typeof flags.domain === 'string' && flags.domain) return flags.domain;
  const cfg = await loadConfig();
  if (cfg && typeof cfg.domain === 'string' && cfg.domain) return cfg.domain;
  return DEFAULT_SUPPORT_DOMAIN;
}

// --- Topic mapping ---

const TOPIC_MAP = {
  'audio-video':          'b89ef3f0',
  'audio & video':        'b89ef3f0',
  'billing-plans':        'd3f536e7',
  'billing & plans':      'd3f536e7',
  'connection-trouble':   '64e8f7e3',
  'connection trouble':   '64e8f7e3',
  'managing-channels':    'd6a571f9',
  'managing channels':    'd6a571f9',
  'managing-members':     '0ad375ea',
  'managing members':     '0ad375ea',
  'notifications':        '61b8b0fd',
  'signing-in':           '0f8332f4',
  'signing in':           '0f8332f4',
  'slack-connect':        'b23e7dcc',
  'slack connect':        'b23e7dcc',
  'workflow-builder':     '74d735fa',
  'workflow builder':     '74d735fa',
  'workspace-migration':  'c3caf4fe',
  'workspace migration':  'c3caf4fe',
  // Raw IDs as passthrough
  'b89ef3f0': 'b89ef3f0',
  'd3f536e7': 'd3f536e7',
  '64e8f7e3': '64e8f7e3',
  'd6a571f9': 'd6a571f9',
  '0ad375ea': '0ad375ea',
  '61b8b0fd': '61b8b0fd',
  '0f8332f4': '0f8332f4',
  'b23e7dcc': 'b23e7dcc',
  '74d735fa': '74d735fa',
  'c3caf4fe': 'c3caf4fe',
};

function resolveTopicId(input) {
  const key = input.toLowerCase().trim();
  const id = TOPIC_MAP[key];
  if (!id) {
    console.error(`Error: Unknown topic "${input}".`);
    console.error('Valid topics:');
    console.error('  audio-video, billing-plans, connection-trouble, managing-channels,');
    console.error('  managing-members, notifications, signing-in, slack-connect,');
    console.error('  workflow-builder, workspace-migration');
    console.error('Or use a raw topic ID (e.g. b89ef3f0).');
    process.exit(1);
  }
  return id;
}

// --- Tab management ---

let _tab = null;

async function findSupportTab() {
  if (_tab) return _tab;

  let tab = await browser.findTab({ domain: SUPPORT_DOMAIN });
  if (!tab) {
    try {
      tab = await browser.ensureTab(REQUESTS_URL);
    } catch (e) {
      console.error(`Error: Failed to open support portal tab at ${REQUESTS_URL}: ${(e && e.message) || e}`);
      process.exit(1);
    }
    // Give the page (and any SSO redirect) a moment to settle before scraping.
    await new Promise(r => setTimeout(r, 2500));
  }

  _tab = tab;
  return _tab;
}

// --- Eval helper ---
// Runs an async page script in the support tab via the sliccy:browser bridge.
// Each script fetches its target page (same-origin, credentialed) and parses
// the server-rendered HTML with DOMParser, so no navigation or temp files are
// needed.

async function evalInSupportTab(jsCode, { fatal = true } = {}) {
  const tab = await findSupportTab();

  let data;
  try {
    data = await browser.evalAsync(tab, jsCode);
  } catch (e) {
    if (!fatal) return { __error: true, message: 'Eval failed: ' + ((e && e.message) || String(e)) };
    console.error('Eval failed:', (e && e.message) || String(e));
    process.exit(1);
  }

  // browser.evalAsync returns parsed JSON; defensively unwrap a JSON string.
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data);
    } catch (e) {
      if (!fatal) return { __error: true, message: 'Parse failed: ' + data.substring(0, 200) };
      console.error('Failed to parse response:', data.substring(0, 200));
      process.exit(1);
    }
  }

  return data;
}

// --- Formatters ---

function truncate(str, len) {
  if (!str) return '';
  str = str.replace(/\n/g, ' ').trim();
  return str.length > len ? str.substring(0, len - 1) + '…' : str;
}

function padRight(str, len) {
  str = str || '';
  return str.length >= len ? str.substring(0, len) : str + ' '.repeat(len - str.length);
}

// --- Scraping JS templates ---

function makeScrapeListJs(requestsUrl) {
  return `
(async () => {
  const results = { open: [], closed: [] };

  const resp = await fetch(${JSON.stringify(requestsUrl)}, { credentials: 'same-origin' });
  const html = await resp.text();
  const doc = new DOMParser().parseFromString(html, 'text/html');

  // Status comes straight from each row's own marker — every issue_row link
  // carries data-js="open-request" or data-js="closed-request". This is far
  // more reliable than inferring status from heading-to-table proximity,
  // which breaks whenever one bucket is empty (e.g. zero open requests: the
  // generic "Your Help Requests" heading ends up claiming the Closed
  // Requests table because there's no Open Requests heading/table to
  // compete with it).
  const rows = doc.querySelectorAll('tr.issue_row');
  for (const row of rows) {
    const id = row.getAttribute('data-id') || '';
    const openLink = row.querySelector('a[data-js="open-request"]');
    const closedLink = row.querySelector('a[data-js="closed-request"]');
    const linkEl = openLink || closedLink;
    const status = openLink ? 'open' : (closedLink ? 'closed' : 'open');
    const title = linkEl ? linkEl.textContent.trim() : '';
    const tds = row.querySelectorAll('td');
    const updated = tds.length > 1 ? tds[1].textContent.trim() : '';
    results[status].push({ id, title, updated, status });
  }

  return JSON.stringify(results);
})()
`;
}

function makeScrapeDetailJs(detailUrl) {
  return `
(async () => {
  const result = {
    title: '',
    requestId: '',
    comments: [],
    crumb: '',
    hasResolveForm: false,
  };

  const resp = await fetch(${JSON.stringify(detailUrl)}, { credentials: 'same-origin' });
  const html = await resp.text();
  const doc = new DOMParser().parseFromString(html, 'text/html');

  // Title
  const h2 = doc.querySelector('h2.no_bottom_margin');
  result.title = h2 ? h2.textContent.trim() : '';

  // Request ID from subtitle
  const subtle = doc.querySelector('p.subtle_silver');
  if (subtle) {
    const m = subtle.textContent.match(/Support Request #(\\d+)/i);
    if (m) result.requestId = m[1];
  }

  // Comments: parse alternating author/timestamp/body blocks
  const authors = doc.querySelectorAll('strong.issue_comment_from');
  const timestamps = doc.querySelectorAll('span.mini');
  const bodies = doc.querySelectorAll('div.break_word');

  const count = Math.min(authors.length, bodies.length);
  for (let i = 0; i < count; i++) {
    result.comments.push({
      author: authors[i] ? authors[i].textContent.trim() : 'Unknown',
      timestamp: timestamps[i] ? timestamps[i].textContent.trim() : '',
      body: bodies[i] ? bodies[i].textContent.trim() : '',
    });
  }

  // CSRF crumb from reply form
  const replyForm = doc.querySelector('form#reply_form');
  if (replyForm) {
    const crumbInput = replyForm.querySelector('input[name="crumb"]');
    if (crumbInput) result.crumb = crumbInput.value;
  }

  // Check for resolve form
  const resolveForm = doc.querySelector('form#resolve_form');
  result.hasResolveForm = !!resolveForm;
  if (resolveForm && !result.crumb) {
    const crumbInput = resolveForm.querySelector('input[name="crumb"]');
    if (crumbInput) result.crumb = crumbInput.value;
  }

  return JSON.stringify(result);
})()
`;
}

function makeReplyJs(requestId, message, detailUrl) {
  const escapedMessage = JSON.stringify(message);
  return `
(async () => {
  const pageResp = await fetch(${JSON.stringify(detailUrl)}, { credentials: 'same-origin' });
  const pageHtml = await pageResp.text();
  const doc = new DOMParser().parseFromString(pageHtml, 'text/html');

  // Get the crumb from the reply form
  const form = doc.querySelector('form#reply_form');
  if (!form) return JSON.stringify({ ok: false, error: 'No reply form found on page' });

  const crumbInput = form.querySelector('input[name="crumb"]');
  if (!crumbInput) return JSON.stringify({ ok: false, error: 'No crumb found in reply form' });
  const crumb = crumbInput.value;

  const params = new URLSearchParams();
  params.append('reply', '1');
  params.append('crumb', crumb);
  params.append('message', ${escapedMessage});

  try {
    const resp = await fetch('/help/requests/${requestId}', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      credentials: 'same-origin',
      body: params.toString(),
    });
    return JSON.stringify({
      ok: resp.ok || resp.status === 302 || resp.status === 301 || resp.status === 200,
      status: resp.status,
      redirected: resp.redirected,
      url: resp.url,
    });
  } catch (e) {
    return JSON.stringify({ ok: false, error: e.message });
  }
})()
`;
}

function makeResolveJs(requestId, detailUrl) {
  return `
(async () => {
  const pageResp = await fetch(${JSON.stringify(detailUrl)}, { credentials: 'same-origin' });
  const pageHtml = await pageResp.text();
  const doc = new DOMParser().parseFromString(pageHtml, 'text/html');

  // Get the crumb from the resolve form
  const form = doc.querySelector('form#resolve_form');
  if (!form) return JSON.stringify({ ok: false, error: 'No resolve form found. The request may already be resolved.' });

  const crumbInput = form.querySelector('input[name="crumb"]');
  if (!crumbInput) return JSON.stringify({ ok: false, error: 'No crumb found in resolve form' });
  const crumb = crumbInput.value;

  const params = new URLSearchParams();
  params.append('resolve', '1');
  params.append('crumb', crumb);

  try {
    const resp = await fetch('/help/requests/${requestId}', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      credentials: 'same-origin',
      body: params.toString(),
    });
    return JSON.stringify({
      ok: resp.ok || resp.status === 302 || resp.status === 301 || resp.status === 200,
      status: resp.status,
      redirected: resp.redirected,
      url: resp.url,
    });
  } catch (e) {
    return JSON.stringify({ ok: false, error: e.message });
  }
})()
`;
}

function makeCreateJs(topicId, title, message, newUrl) {
  const escapedTitle = JSON.stringify(title);
  const escapedMessage = JSON.stringify(message);
  return `
(async () => {
  const pageResp = await fetch(${JSON.stringify(newUrl)}, { credentials: 'same-origin' });
  const pageHtml = await pageResp.text();
  const doc = new DOMParser().parseFromString(pageHtml, 'text/html');

  // Get the crumb from the create form
  const crumbInput = doc.querySelector('input[name="crumb"]');
  if (!crumbInput) return JSON.stringify({ ok: false, error: 'No crumb found on new request page' });
  const crumb = crumbInput.value;

  const params = new URLSearchParams();
  params.append('create', '1');
  params.append('crumb', crumb);
  params.append('topic', '${topicId}');
  params.append('title', ${escapedTitle});
  params.append('text', ${escapedMessage});

  try {
    const resp = await fetch('/help/requests/new', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      credentials: 'same-origin',
      redirect: 'follow',
      body: params.toString(),
    });

    // Extract new request ID from redirect URL
    let newId = '';
    const urlMatch = resp.url.match(/\\/help\\/requests\\/(\\d+)/);
    if (urlMatch) newId = urlMatch[1];

    // Fallback: parse the response body for the ID
    if (!newId) {
      try {
        const body = await resp.text();
        const bodyMatch = body.match(/Support Request #(\\d+)/i);
        if (bodyMatch) newId = bodyMatch[1];
      } catch (_) {}
    }

    return JSON.stringify({
      ok: resp.ok || resp.status === 302 || resp.status === 301 || resp.status === 200,
      status: resp.status,
      redirected: resp.redirected,
      url: resp.url,
      newId: newId,
    });
  } catch (e) {
    return JSON.stringify({ ok: false, error: e.message });
  }
})()
`;
}

function validateRequestId(id) {
  if (!/^\d+$/.test(id)) {
    console.error(`Error: Invalid request ID "${id}". Expected a numeric ID (e.g. 6750592).`);
    process.exit(1);
  }
  return id;
}

// --- Commands ---

const commands = {

  async list(flags, positional) {
    const status = (typeof flags.status === 'string' ? flags.status : 'all').toLowerCase();

    if (!['open', 'closed', 'all'].includes(status)) {
      console.error('Error: --status must be "open", "closed", or "all".');
      process.exit(1);
    }

    const data = await evalInSupportTab(makeScrapeListJs(REQUESTS_URL));

    if (data.__error) {
      console.error('Error:', data.message);
      process.exit(1);
    }

    let rows = [];
    if (status === 'all' || status === 'open') {
      rows = rows.concat(data.open || []);
    }
    if (status === 'all' || status === 'closed') {
      rows = rows.concat(data.closed || []);
    }

    if (rows.length === 0) {
      console.log(`No ${status === 'all' ? '' : status + ' '}requests found.`);
      return;
    }

    // Calculate column widths
    const idW = Math.max(2, ...rows.map(r => r.id.length));
    const statusW = 6;
    const titleW = Math.min(50, Math.max(5, ...rows.map(r => r.title.length)));
    const updatedW = Math.max(12, ...rows.map(r => r.updated.length));

    // Header
    console.log(`${padRight('ID', idW + 2)}${padRight('Status', statusW + 2)}${padRight('Title', titleW + 2)}Last Updated`);
    console.log(`${'─'.repeat(idW + 2)}${'─'.repeat(statusW + 2)}${'─'.repeat(titleW + 2)}${'─'.repeat(updatedW)}`);

    for (const r of rows) {
      const title = truncate(r.title, titleW);
      const st = r.status === 'open' ? 'Open' : 'Closed';
      console.log(`${padRight(r.id, idW + 2)}${padRight(st, statusW + 2)}${padRight(title, titleW + 2)}${r.updated}`);
    }

    const openCount = (data.open || []).length;
    const closedCount = (data.closed || []).length;
    console.log(`\n${openCount} open, ${closedCount} closed.`);
  },

  async view(flags, positional) {
    const id = positional[0];

    if (!id) {
      console.error('Usage: slack-support view <request_id>');
      process.exit(1);
    }
    validateRequestId(id);

    const detailUrl = `${REQUESTS_URL}/${id}`;
    const data = await evalInSupportTab(makeScrapeDetailJs(detailUrl));

    if (data.__error) {
      console.error('Error:', data.message);
      process.exit(1);
    }

    if (!data.title && !data.requestId) {
      console.error(`Error: Could not load request ${id}. The page may not exist or you may not have access.`);
      process.exit(1);
    }

    // Print header
    console.log(`${data.title}`);
    if (data.requestId) {
      console.log(`Support Request #${data.requestId}`);
    }
    console.log('─'.repeat(60));

    // Print comments
    if (!data.comments || data.comments.length === 0) {
      console.log('(No comments)');
    } else {
      for (let i = 0; i < data.comments.length; i++) {
        const c = data.comments[i];
        if (i > 0) console.log('');
        console.log(`${c.author}  ${c.timestamp}`);
        console.log(c.body);
      }
    }
  },

  async reply(flags, positional) {
    const id = positional[0];
    const message = positional.slice(1).join(' ');

    if (!id || !message) {
      console.error('Usage: slack-support reply <request_id> <message>');
      process.exit(1);
    }

    const detailUrl = `${REQUESTS_URL}/${id}`;

    // Fetch the detail page for a fresh crumb, then submit the reply.
    const data = await evalInSupportTab(makeReplyJs(id, message, detailUrl));

    if (data.__error) {
      console.error('Error:', data.message);
      process.exit(1);
    }

    if (!data.ok) {
      console.error('Error submitting reply:', data.error || `HTTP ${data.status}`);
      process.exit(1);
    }

    console.log(`Reply sent to request ${id}.`);
    if (data.status) console.log(`  Status: ${data.status}`);
  },

  async create(flags, positional) {
    const topic = flags.topic;
    const title = flags.title;
    const message = positional.join(' ');

    if (!topic || !title || !message) {
      console.error('Usage: slack-support create --topic=<topic> --title=<title> <message>');
      console.error('');
      console.error('Topics: audio-video, billing-plans, connection-trouble, managing-channels,');
      console.error('        managing-members, notifications, signing-in, slack-connect,');
      console.error('        workflow-builder, workspace-migration');
      process.exit(1);
    }

    const topicId = resolveTopicId(topic);
    const newUrl = `${REQUESTS_URL}/new`;

    const data = await evalInSupportTab(makeCreateJs(topicId, title, message, newUrl));

    if (data.__error) {
      console.error('Error:', data.message);
      process.exit(1);
    }

    if (!data.ok) {
      console.error('Error creating request:', data.error || `HTTP ${data.status}`);
      process.exit(1);
    }

    if (data.newId) {
      console.log(`Request created: #${data.newId}`);
      console.log(`  URL: ${REQUESTS_URL}/${data.newId}`);
    } else {
      console.error('Warning: Request may not have been created — no request ID returned.');
      console.error('Check the support portal manually.');
      if (data.url) console.error(`  Response URL: ${data.url}`);
      process.exit(1);
    }
    console.log(`  Topic: ${topic} (${topicId})`);
    console.log(`  Title: ${title}`);
  },

  async resolve(flags, positional) {
    const id = positional[0];

    if (!id) {
      console.error('Usage: slack-support resolve <request_id>');
      process.exit(1);
    }

    const detailUrl = `${REQUESTS_URL}/${id}`;

    const data = await evalInSupportTab(makeResolveJs(id, detailUrl));

    if (data.__error) {
      console.error('Error:', data.message);
      process.exit(1);
    }

    if (!data.ok) {
      console.error('Error resolving request:', data.error || `HTTP ${data.status}`);
      process.exit(1);
    }

    console.log(`Request ${id} resolved.`);
    if (data.status) console.log(`  Status: ${data.status}`);
  },

  async config(flags, positional) {
    if (typeof flags.domain === 'string' && flags.domain) {
      const cur = await loadConfig();
      await skill.config({ ...cur, domain: flags.domain });
      console.log(`Support portal domain set to "${flags.domain}".`);
      return;
    }

    const cfg = await loadConfig();
    console.log(`Current domain: ${SUPPORT_DOMAIN}`);
    console.log(`  Source: ${cfg && cfg.domain ? 'skill config' : 'built-in default'}`);
    console.log('');
    console.log('Set with: slack-support config --domain=<host>');
  },
};

// --- Main ---

const { flags, positional } = process.argv.parseFlags();
const cmd = positional[0];
const args = positional.slice(1);

// Resolve the support-portal domain before anything else touches
// SUPPORT_DOMAIN/BASE_URL/REQUESTS_URL (including the help banner below).
SUPPORT_DOMAIN = await resolveSupportDomain(flags);
BASE_URL = `https://${SUPPORT_DOMAIN}`;
REQUESTS_URL = `${BASE_URL}/help/requests`;

if (!cmd || cmd === 'help') {
  console.log('Slack Support Portal — manage help requests from the command line.\n');
  console.log('Usage: slack-support <command> [args]\n');
  console.log('Commands:');
  console.log('  list [--status=open|closed|all]           List help requests (default: all)');
  console.log('  view <id>                                 View request details and comments');
  console.log('  reply <id> <message>                      Reply to a request');
  console.log('  create --topic=<t> --title=<t> <message>  Create a new request');
  console.log('  resolve <id>                              Resolve a request');
  console.log('  config [--domain=<host>]                  Show or set the support portal domain');
  console.log('  help                                      Show this help\n');
  console.log('Topics for create:');
  console.log('  audio-video, billing-plans, connection-trouble, managing-channels,');
  console.log('  managing-members, notifications, signing-in, slack-connect,');
  console.log('  workflow-builder, workspace-migration\n');
  console.log('Examples:');
  console.log('  slack-support list');
  console.log('  slack-support list --status=open');
  console.log('  slack-support view 6750592');
  console.log('  slack-support reply 6750592 "Thanks, that fixed it."');
  console.log('  slack-support create --topic=slack-connect --title="Connect issue" "Cannot invite external user"');
  console.log('  slack-support resolve 6750592');
  console.log('  slack-support config --domain=your-org.enterprise.slack.com\n');
  console.log(`Support portal domain: ${SUPPORT_DOMAIN}`);
  console.log('(override with --domain=<host>, or persist with the config command)');
  console.log('If no matching browser tab is open, one is opened automatically.');
  process.exit(0);
}

if (!commands[cmd]) {
  console.error(`Unknown command: ${cmd}`);
  console.error('Run "slack-support help" for usage.');
  process.exit(1);
}

await commands[cmd](flags, args);
