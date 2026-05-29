// jira.jsh — Jira CLI via browser SSO session
// Usage: jira <command> [args]
//   jira detect
//   jira whoami
//   jira get <issue-key>
//   jira search "<jql>"
//   jira comments <issue-key>

// --- Tab management ---

let _tabId = null;
let _jiraBase = null;

async function findJiraTab() {
  if (_tabId) return _tabId;
  const list = await exec('playwright-cli tab-list');
  if (list.exitCode !== 0) {
    console.error('Error: Failed to list browser tabs.');
    if (list.stderr) console.error(list.stderr.trim());
    process.exit(1);
  }
  const lines = list.stdout.split('\n');
  for (const line of lines) {
    if (line.toLowerCase().includes('jira')) {
      const m = line.match(/^\[([^\]]+)\]/);
      const urlMatch = line.match(/https?:\/\/\S+/);
      if (m && urlMatch) {
        _tabId = m[1];
        _jiraBase = urlMatch[0].match(/^https?:\/\/[^\/]+/)[0];
        return _tabId;
      }
    }
  }
  console.error('Error: No Jira tab found. Open Jira in your browser and try again.');
  process.exit(1);
}

// --- Eval helper ---
// Writes JS to a temp file, evals in the Jira tab, returns parsed JSON.

async function evalInJiraTab(expr, { fatal = true } = {}) {
  const tabId = await findJiraTab();
  const tmpFile = '/shared/.jira_eval_' + Date.now() + '.js';
  await fs.writeFile(tmpFile, expr.trim());
  const result = await exec(`playwright-cli eval-file ${tmpFile} --tab=${tabId}`);
  await fs.rm(tmpFile).catch(async () => {
    await fs.writeFile(tmpFile, '').catch(() => {});
  });

  if (result.exitCode !== 0) {
    if (!fatal) return null;
    console.error('Eval failed:', result.stderr);
    process.exit(1);
  }

  let data;
  try {
    const stdout = result.stdout.trim();
    data = JSON.parse(stdout);
    if (typeof data === 'string') data = JSON.parse(data);
  } catch (e) {
    if (!fatal) return null;
    console.error('Failed to parse API response:', result.stdout.substring(0, 200));
    process.exit(1);
  }

  return data;
}

// --- API helper ---

async function jiraFetch(path) {
  await findJiraTab();
  const url = _jiraBase + path;
  const expr = `
(async () => {
  const r = await fetch(${JSON.stringify(url)}, { credentials: 'include' });
  if (!r.ok) return JSON.stringify({ __error: r.status });
  return r.text();
})()
  `.trim();
  const data = await evalInJiraTab(expr);
  if (data && data.__error) {
    console.error(`API error ${data.__error}. Is your Jira session active?`);
    process.exit(1);
  }
  return data;
}

// --- Formatters ---

function fmtDate(d) {
  return d ? d.slice(0, 10) : '';
}

function stripWiki(text) {
  if (!text) return '';
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\{color:[^}]+\}([\s\S]*?)\{color\}/g, '$1')
    .replace(/\{\*\}([\s\S]*?)\{\*\}/g, '$1')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/_([^_\n]+)_/g, '$1')
    .replace(/\{\{([^}]+)\}\}/g, '$1')
    .replace(/\[([^\|\]]+)\|[^\]]+\]/g, '$1')
    .replace(/^\s*[#\-]\s+/gm, '')
    .trim();
}

// --- Commands ---

async function detect() {
  await findJiraTab();
  console.log(`Found Jira tab: ${_jiraBase}`);
  console.log('Please confirm this is the correct Jira instance before proceeding.');
}

async function whoami() {
  const data = await jiraFetch('/rest/api/2/myself');
  console.log(`Authenticated as: ${data.displayName} (${data.emailAddress})`);
}

async function get(key) {
  if (!key) { console.error('Usage: jira get <issue-key>'); process.exit(1); }
  const data = await jiraFetch(`/rest/api/2/issue/${key}`);
  const f = data.fields;
  const out = [
    `${data.key}: ${f.summary}`,
    `  Type:        ${f.issuetype?.name || ''}`,
    `  Status:      ${f.status?.name || ''}`,
    `  Assignee:    ${f.assignee?.displayName || 'Unassigned'}`,
    `  Reporter:    ${f.reporter?.displayName || ''}`,
    `  Created:     ${fmtDate(f.created)}`,
    `  Updated:     ${fmtDate(f.updated)}`,
  ];
  if (f.components?.length) out.push(`  Components:  ${f.components.map(c => c.name).join(', ')}`);
  if (f.fixVersions?.length) out.push(`  Fix Versions: ${f.fixVersions.map(v => v.name).join(', ')}`);
  if (f.labels?.length) out.push(`  Labels:      ${f.labels.join(', ')}`);
  out.push('', '  Description:');
  if (f.description) {
    stripWiki(f.description).split('\n').forEach(l => out.push(`    ${l}`));
  } else {
    out.push('    (none)');
  }
  console.log(out.join('\n'));
}

async function search(jql) {
  if (!jql) { console.error('Usage: jira search "<jql>"'); process.exit(1); }
  const encoded = encodeURIComponent(jql);
  const data = await jiraFetch(`/rest/api/2/search?jql=${encoded}&maxResults=50&fields=summary,status,assignee,issuetype`);
  const issues = data.issues || [];
  console.log(`${data.total} issue(s) found (showing ${issues.length}):\n`);
  issues.forEach(i => {
    const status = i.fields.status?.name || '';
    console.log(`  ${i.key}: ${i.fields.summary} [${status}]`);
  });
}

async function comments(key) {
  if (!key) { console.error('Usage: jira comments <issue-key>'); process.exit(1); }
  const data = await jiraFetch(`/rest/api/2/issue/${key}/comment`);
  const items = data.comments || [];
  console.log(`Comments on ${key} (${items.length}):\n`);
  items.forEach(c => {
    console.log(`  [${fmtDate(c.created)}] ${c.author?.displayName || 'Unknown'}:`);
    stripWiki(c.body).split('\n').slice(0, 20).forEach(l => console.log(`    ${l}`));
    console.log('');
  });
}

// --- Main ---

const rawArgs = process.argv.slice(2);
const [cmd, ...cmdArgs] = rawArgs;

if (!cmd || cmd === 'help' || cmd === '--help') {
  console.log('Jira CLI — interact with Jira via the browser SSO session.\n');
  console.log('Usage: jira <command> [args]\n');
  console.log('Commands:');
  console.log('  detect                        Find the Jira tab and confirm the instance URL');
  console.log('  whoami                        Verify auth — prints logged-in user');
  console.log('  get <issue-key>               Fetch a single issue with full detail');
  console.log('  search "<jql>"                Run a JQL query (up to 50 results)');
  console.log('  comments <issue-key>          Fetch all comments on an issue');
  process.exit(0);
}

switch (cmd) {
  case 'detect':   await detect(); break;
  case 'whoami':   await whoami(); break;
  case 'get':      await get(cmdArgs[0]); break;
  case 'search':   await search(cmdArgs.join(' ')); break;
  case 'comments': await comments(cmdArgs[0]); break;
  default:
    console.error(`Unknown command: ${cmd}`);
    console.error('Run "jira help" for usage.');
    process.exit(1);
}
