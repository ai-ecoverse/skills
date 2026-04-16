// Slack Support Portal client — scrapes adobe-dx-support.enterprise.slack.com
// Uses playwright-cli to interact with the server-rendered support portal.
// Cookie-based auth via existing browser session — no REST API available.

const SUPPORT_DOMAIN = 'adobe-dx-support.enterprise.slack.com';
const BASE_URL = `https://${SUPPORT_DOMAIN}`;
const REQUESTS_URL = `${BASE_URL}/help/requests`;

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

let _tabId = null;

async function findSupportTab() {
  if (_tabId) return _tabId;

  const list = await exec('playwright-cli tab-list');
  if (list.exitCode !== 0) {
    console.error('Error: Failed to list browser tabs.');
    if (list.stderr?.trim()) console.error(list.stderr.trim());
    process.exit(1);
  }

  const lines = list.stdout.split('\n');
  for (const line of lines) {
    if (line.includes(SUPPORT_DOMAIN)) {
      const m = line.match(/^\[([^\]]+)\]/);
      if (m) {
        _tabId = m[1];
        return _tabId;
      }
    }
  }

  console.error(`Error: No support portal tab found. Open ${REQUESTS_URL} in your browser and try again.`);
  process.exit(1);
}

// --- Eval helper ---
// Writes JS to a temp file, evaluates it in the support tab, parses the result.

async function evalInSupportTab(jsCode, { navigate = null, fatal = true } = {}) {
  const tabId = await findSupportTab();

  // Navigate first if requested
  if (navigate) {
    const nav = await exec(`playwright-cli goto "${navigate}" --tab=${tabId} --wait=networkidle`);
    if (nav.exitCode !== 0) {
      if (!fatal) return { __error: true, message: 'Navigation failed: ' + (nav.stderr || '') };
      console.error('Navigation failed:', nav.stderr || 'unknown error');
      process.exit(1);
    }
  }

  const tmpFile = '/shared/.slack_support_' + Date.now() + '_' + Math.random().toString(36).slice(2) + '.js';
  await fs.writeFile(tmpFile, jsCode);

  const result = await exec(`playwright-cli eval-file "${tmpFile}" --tab=${tabId}`);
  await fs.rm(tmpFile).catch(() => {});

  if (result.exitCode !== 0) {
    if (!fatal) return { __error: true, message: result.stderr || 'eval failed' };
    console.error('Eval failed:', result.stderr);
    process.exit(1);
  }

  let data;
  try {
    const stdout = result.stdout.trim();
    data = JSON.parse(stdout);
    if (typeof data === 'string') data = JSON.parse(data);
  } catch (e) {
    if (!fatal) return { __error: true, message: 'Parse failed: ' + result.stdout.substring(0, 200) };
    console.error('Failed to parse response:', result.stdout.substring(0, 200));
    process.exit(1);
  }

  return data;
}

// --- Argument parsing (matches slack.jsh pattern) ---

function parseArgs(args) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq > 0) {
        flags[arg.substring(2, eq)] = arg.substring(eq + 1);
      } else {
        const name = arg.substring(2);
        if (i + 1 < args.length && !args[i + 1].startsWith('--')) {
          flags[name] = args[++i];
        } else {
          flags[name] = true;
        }
      }
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
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

const SCRAPE_LIST_JS = `
(async () => {
  const results = { open: [], closed: [] };

  function parseTable(table, status) {
    if (!table) return;
    const rows = table.querySelectorAll('tr.issue_row');
    for (const row of rows) {
      const id = row.getAttribute('data-id') || '';
      const linkEl = row.querySelector('a[data-js="open-request"], a[data-js="closed-request"]');
      const title = linkEl ? linkEl.textContent.trim() : '';
      const tds = row.querySelectorAll('td');
      const updated = tds.length > 1 ? tds[1].textContent.trim() : '';
      results[status].push({ id, title, updated, status });
    }
  }

  // Find tables by proximity to headings
  const headings = document.querySelectorAll('h2');
  for (const h of headings) {
    const text = h.textContent.trim().toLowerCase();
    let sibling = h.nextElementSibling;
    while (sibling && sibling.tagName !== 'TABLE') {
      sibling = sibling.nextElementSibling;
    }
    if (!sibling) continue;
    if (text.includes('your help requests') || text.includes('open')) {
      parseTable(sibling, 'open');
    } else if (text.includes('closed')) {
      parseTable(sibling, 'closed');
    }
  }

  // Fallback: if no headings matched, try all issue_row tables
  if (results.open.length === 0 && results.closed.length === 0) {
    const tables = document.querySelectorAll('table');
    for (let i = 0; i < tables.length; i++) {
      const status = i === 0 ? 'open' : 'closed';
      parseTable(tables[i], status);
    }
  }

  return JSON.stringify(results);
})()
`;

function makeScrapeDetailJs(requestId) {
  return `
(async () => {
  const result = {
    title: '',
    requestId: '',
    comments: [],
    crumb: '',
    hasResolveForm: false,
  };

  // Title
  const h2 = document.querySelector('h2.no_bottom_margin');
  result.title = h2 ? h2.textContent.trim() : '';

  // Request ID from subtitle
  const subtle = document.querySelector('p.subtle_silver');
  if (subtle) {
    const m = subtle.textContent.match(/Support Request #(\\d+)/i);
    if (m) result.requestId = m[1];
  }

  // Comments: parse alternating author/timestamp/body blocks
  const authors = document.querySelectorAll('strong.issue_comment_from');
  const timestamps = document.querySelectorAll('span.mini');
  const bodies = document.querySelectorAll('div.break_word');

  const count = Math.min(authors.length, bodies.length);
  for (let i = 0; i < count; i++) {
    result.comments.push({
      author: authors[i] ? authors[i].textContent.trim() : 'Unknown',
      timestamp: timestamps[i] ? timestamps[i].textContent.trim() : '',
      body: bodies[i] ? bodies[i].textContent.trim() : '',
    });
  }

  // CSRF crumb from reply form
  const replyForm = document.querySelector('form#reply_form');
  if (replyForm) {
    const crumbInput = replyForm.querySelector('input[name="crumb"]');
    if (crumbInput) result.crumb = crumbInput.value;
  }

  // Check for resolve form
  const resolveForm = document.querySelector('form#resolve_form');
  result.hasResolveForm = !!resolveForm;
  if (resolveForm && !result.crumb) {
    const crumbInput = resolveForm.querySelector('input[name="crumb"]');
    if (crumbInput) result.crumb = crumbInput.value;
  }

  return JSON.stringify(result);
})()
`;
}

function makeReplyJs(requestId, message) {
  const escapedMessage = JSON.stringify(message);
  return `
(async () => {
  // Get the crumb from the reply form
  const form = document.querySelector('form#reply_form');
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

function makeResolveJs(requestId) {
  return `
(async () => {
  // Get the crumb from the resolve form
  const form = document.querySelector('form#resolve_form');
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

function makeCreateJs(topicId, title, message) {
  const escapedTitle = JSON.stringify(title);
  const escapedMessage = JSON.stringify(message);
  return `
(async () => {
  // Get the crumb from the create form
  const crumbInput = document.querySelector('input[name="crumb"]');
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

  async list(args) {
    const { flags } = parseArgs(args);
    const status = (typeof flags.status === 'string' ? flags.status : 'all').toLowerCase();

    if (!['open', 'closed', 'all'].includes(status)) {
      console.error('Error: --status must be "open", "closed", or "all".');
      process.exit(1);
    }

    const data = await evalInSupportTab(SCRAPE_LIST_JS, { navigate: REQUESTS_URL });

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

  async view(args) {
    const { positional } = parseArgs(args);
    const id = positional[0];

    if (!id) {
      console.error('Usage: slack-support view <request_id>');
      process.exit(1);
    }
    validateRequestId(id);

    const detailUrl = `${REQUESTS_URL}/${id}`;
    const data = await evalInSupportTab(makeScrapeDetailJs(id), { navigate: detailUrl });

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

  async reply(args) {
    const { positional } = parseArgs(args);
    const id = positional[0];
    const message = positional.slice(1).join(' ');

    if (!id || !message) {
      console.error('Usage: slack-support reply <request_id> <message>');
      process.exit(1);
    }

    const detailUrl = `${REQUESTS_URL}/${id}`;

    // Navigate to detail page to get fresh crumb, then submit reply
    const data = await evalInSupportTab(makeReplyJs(id, message), { navigate: detailUrl });

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

  async create(args) {
    const { flags, positional } = parseArgs(args);
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

    const data = await evalInSupportTab(makeCreateJs(topicId, title, message), { navigate: newUrl });

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

  async resolve(args) {
    const { positional } = parseArgs(args);
    const id = positional[0];

    if (!id) {
      console.error('Usage: slack-support resolve <request_id>');
      process.exit(1);
    }

    const detailUrl = `${REQUESTS_URL}/${id}`;

    const data = await evalInSupportTab(makeResolveJs(id), { navigate: detailUrl });

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
};

// --- Main ---

const rawArgs = process.argv.slice(2);
const [cmd, ...args] = rawArgs;

if (!cmd || cmd === 'help' || cmd === '--help') {
  console.log('Slack Support Portal — manage help requests from the command line.\n');
  console.log('Usage: slack-support <command> [args]\n');
  console.log('Commands:');
  console.log('  list [--status=open|closed|all]           List help requests (default: all)');
  console.log('  view <id>                                 View request details and comments');
  console.log('  reply <id> <message>                      Reply to a request');
  console.log('  create --topic=<t> --title=<t> <message>  Create a new request');
  console.log('  resolve <id>                              Resolve a request');
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
  console.log('  slack-support resolve 6750592\n');
  console.log(`Requires an open browser tab at ${SUPPORT_DOMAIN}.`);
  process.exit(0);
}

if (!commands[cmd]) {
  console.error(`Unknown command: ${cmd}`);
  console.error('Run "slack-support help" for usage.');
  process.exit(1);
}

await commands[cmd](args);
