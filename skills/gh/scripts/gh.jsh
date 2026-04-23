// gh.jsh — GitHub CLI for SLICC agents
// Usage: gh <command> <subcommand> [args] [owner/repo]

// ─── Auth ────────────────────────────────────────────────────────────────────

const _tokenResult = await exec('git config github.token 2>/dev/null');
const token = _tokenResult.stdout.trim() || process.env.GITHUB_TOKEN || '';

// ─── AI attribution (ai-aligned-gh) ──────────────────────────────────────────

const isAI = !!(process.env.CLAUDECODE || process.env.CLAUDE_CODE_ENTRYPOINT
  || process.env.GEMINI_CLI || process.env.CODEX_CLI || process.env.CURSOR_AGENT);

const BROKER_URL = process.env.AS_A_BOT_URL || 'https://as-bot-worker.minivelos.workers.dev';
const BOT_CACHE = '/.cache/ai-aligned-gh/token';

const WRITE_OPS = {
  pr:            ['merge','comment','create','edit','close','review'],
  issue:         ['create','edit','close','comment'],
  vars:          ['set'],
  release:       ['create','upload','delete'],
  notifications: ['read'],
};

function isMutating(cmd, sub) {
  return WRITE_OPS[cmd]?.includes(sub);
}

async function getAttributedToken() {
  // 1. Check cache
  try {
    const cached = (await fs.readFile(BOT_CACHE)).trim();
    if (cached) {
      const check = await fetch('https://api.github.com/user', {
        headers: { 'Authorization': `Bearer ${cached}`, 'User-Agent': 'gh.jsh/1.0' }
      });
      if (check.ok) return cached;
    }
  } catch {}

  // 2. Start device flow
  let flow;
  try {
    const r = await fetch(`${BROKER_URL}/user-token/start`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scopes: 'repo' })
    });
    flow = await r.json();
  } catch { return token; } // broker unreachable, fall back

  if (!flow.device_code) return token;

  console.error(`\n⚡ AI attribution required — authorize as-a-bot:\n`);
  console.error(`   Visit: ${flow.verification_uri}`);
  console.error(`   Code:  ${flow.user_code}\n`);

  // 3. Poll
  const interval = (flow.interval || 5) * 1000;
  const expires  = Date.now() + (flow.expires_in || 900) * 1000;
  while (Date.now() < expires) {
    await new Promise(r => setTimeout(r, interval));
    try {
      const p = await fetch(`${BROKER_URL}/user-token/poll`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_code: flow.device_code })
      });
      const result = await p.json();
      if (result.access_token) {
        await fs.writeFile(BOT_CACHE, result.access_token);
        console.error(`✓ Authenticated — actions will appear as you via as-a-bot.\n`);
        return result.access_token;
      }
      if (result.error && result.error !== 'authorization_pending' && result.error !== 'slow_down') break;
    } catch { break; }
  }
  return token; // timed out, fall back
}

async function resolveToken(cmd, sub) {
  if (isAI && isMutating(cmd, sub)) return getAttributedToken();
  return token;
}

// ─── Repo inference ───────────────────────────────────────────────────────────

async function inferRepo() {
  const r = await exec('git remote get-url origin 2>/dev/null');
  if (r.exitCode !== 0 || !r.stdout.trim()) return null;
  const match = r.stdout.trim().match(/github\.com[:/]([^/\s]+\/[^/\s.]+)/);
  return match ? match[1] : null;
}

async function resolveRepo(arg) {
  if (arg && arg.includes('/')) return arg;
  const inferred = await inferRepo();
  if (inferred) return inferred;
  die('No repo specified and could not infer from git remote. Pass owner/repo explicitly.');
}

// ─── ANSI colors ─────────────────────────────────────────────────────────────

const C = {
  green:  s => `\x1b[32m${s}\x1b[0m`,
  red:    s => `\x1b[31m${s}\x1b[0m`,
  yellow: s => `\x1b[33m${s}\x1b[0m`,
  gray:   s => `\x1b[90m${s}\x1b[0m`,
  bold:   s => `\x1b[1m${s}\x1b[0m`,
  cyan:   s => `\x1b[36m${s}\x1b[0m`,
};

const SYM = {
  success:     C.green('✓'),
  failure:     C.red('✗'),
  timed_out:   C.red('✗'),
  action_required: C.red('✗'),
  pending:     C.yellow('●'),
  in_progress: C.yellow('●'),
  queued:      C.yellow('●'),
  waiting:     C.yellow('●'),
  skipped:     C.gray('○'),
  draft:       C.gray('○'),
  cancelled:   C.gray('○'),
  neutral:     C.gray('○'),
  open:        C.green('✓'),
  closed:      C.red('✗'),
  merged:      C.green('✓'),
  stale:       C.gray('○'),
};

function sym(s) { return SYM[s] || C.gray('?'); }

// ─── API ──────────────────────────────────────────────────────────────────────

const GH_BASE = 'https://api.github.com';

async function api(path, opts) {
  opts = opts || {};
  const url = path.startsWith('http') ? path : GH_BASE + path;
  // Use attributed token for mutating requests when running as AI agent
  const isWrite = opts.method && opts.method !== 'GET';
  const activeToken = (isWrite && isAI) ? await getAttributedToken() : token;
  const res = await fetch(url, Object.assign({}, opts, {
    headers: Object.assign({
      'Authorization': activeToken ? `Bearer ${activeToken}` : '',
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    }, opts.headers || {}),
  }));

  let body;
  const ct = res.headers.get('content-type') || '';
  body = ct.includes('json') ? await res.json() : await res.text();

  if (!res.ok) {
    const msg = (body && body.message) ? body.message : JSON.stringify(body);
    throw new Error(`HTTP ${res.status}: ${msg}`);
  }
  return body;
}

// ─── Formatting ───────────────────────────────────────────────────────────────

function trunc(s, n) {
  s = String(s == null ? '' : s);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function pad(s, n) {
  const raw = String(s == null ? '' : s).replace(/\x1b\[[0-9;]*m/g, '');
  const spaces = Math.max(0, n - raw.length);
  return s + ' '.repeat(spaces);
}

function table(rows, widths) {
  return rows.map(row =>
    row.map((cell, i) => i === row.length - 1 ? cell : pad(cell, widths[i])).join('  ').trimEnd()
  ).join('\n');
}

function fmtDate(s) {
  if (!s) return '';
  return new Date(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// ─── Errors ───────────────────────────────────────────────────────────────────

function die(msg) {
  process.stderr.write('gh: ' + msg + '\n');
  process.exit(1);
}

function fail(cmd, err) {
  die(cmd + ' failed: ' + err.message);
}

// ─── pr list ─────────────────────────────────────────────────────────────────

async function prList(args) {
  const repo = await resolveRepo(args[0]);
  let prs;
  try { prs = await api(`/repos/${repo}/pulls?state=open&per_page=30`); }
  catch (e) { fail('pr list', e); }

  if (!prs.length) { console.log(C.gray('No open pull requests.')); return; }

  const rows = prs.map(pr => [
    C.cyan('#' + pr.number),
    trunc(pr.title, 52),
    C.gray(trunc(pr.head.ref, 36)),
    pr.draft ? C.green('open') + '  ' + C.yellow('[DRAFT]') : C.green('open'),
  ]);
  console.log(table(rows, [6, 54, 38]));
}

// ─── pr view ─────────────────────────────────────────────────────────────────

async function prView(args) {
  if (!args[0]) die('pr view: PR number required');
  const repo = await resolveRepo(args[1]);
  let pr, checks;
  try { pr = await api(`/repos/${repo}/pulls/${args[0]}`); }
  catch (e) { fail('pr view', e); }
  try { checks = await api(`/repos/${repo}/commits/${pr.head.sha}/check-runs?per_page=30`); }
  catch { checks = { check_runs: [] }; }

  const statusStr = pr.merged ? sym('merged') + ' ' + C.green('merged')
    : pr.draft ? sym('draft') + ' ' + C.gray('draft')
    : sym(pr.state) + ' ' + (pr.state === 'open' ? C.green('open') : C.red('closed'));

  console.log(C.bold(pr.title) + '  ' + statusStr);
  console.log(C.gray('Author:') + '  ' + pr.user.login);
  console.log(C.gray('Branch:') + '  ' + pr.head.ref + ' → ' + pr.base.ref);
  console.log(C.gray('URL:') + '     ' + pr.html_url);

  const runs = (checks.check_runs || []);
  if (runs.length) {
    const passed  = runs.filter(r => r.conclusion === 'success').length;
    const failed  = runs.filter(r => r.conclusion === 'failure' || r.conclusion === 'timed_out').length;
    const pending = runs.filter(r => !r.conclusion || r.status === 'in_progress' || r.status === 'queued').length;
    const parts = [
      passed  ? C.green(passed + ' passed')   : null,
      failed  ? C.red(failed + ' failed')     : null,
      pending ? C.yellow(pending + ' pending') : null,
    ].filter(Boolean);
    if (parts.length) console.log(C.gray('Checks:') + '  ' + parts.join('  '));
  }

  if (pr.body) {
    console.log('\n' + C.gray('Body:'));
    console.log(trunc(pr.body.replace(/\r?\n/g, ' '), 400));
  }
}

// ─── pr merge ────────────────────────────────────────────────────────────────

async function prMerge(args) {
  if (!args[0]) die('pr merge: PR number required');
  let method = 'merge';
  const rest = [];
  for (const a of args.slice(1)) {
    if (a === '--squash') method = 'squash';
    else if (a === '--rebase') method = 'rebase';
    else if (a === '--merge') method = 'merge';
    else rest.push(a);
  }
  const repo = await resolveRepo(rest[0]);
  try {
    const res = await api(`/repos/${repo}/pulls/${args[0]}/merge`, {
      method: 'PUT',
      body: JSON.stringify({ merge_method: method }),
    });
    console.log(sym('merged') + ' ' + C.green('Merged') + ' PR #' + args[0] + ' via ' + method + (res.message ? ' — ' + res.message : ''));
  } catch (e) { fail('pr merge', e); }
}

// ─── pr comment ──────────────────────────────────────────────────────────────

async function prComment(args) {
  if (!args[0]) die('pr comment: PR number required');
  if (!args[1]) die('pr comment: message required');
  const repo = await resolveRepo(args[2]);
  try {
    const res = await api(`/repos/${repo}/issues/${args[0]}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body: args[1] }),
    });
    console.log(sym('success') + ' Comment posted: ' + res.html_url);
  } catch (e) { fail('pr comment', e); }
}

// ─── pr checkout ─────────────────────────────────────────────────────────────

async function prCheckout(args) {
  if (!args[0]) die('pr checkout: PR number required');
  const repo = await resolveRepo(args[1]);
  let pr;
  try { pr = await api(`/repos/${repo}/pulls/${args[0]}`); }
  catch (e) { fail('pr checkout', e); }

  const branch = pr.head.ref;
  const remoteUrl = pr.head.repo ? pr.head.repo.clone_url : `https://github.com/${repo}.git`;
  console.log(C.gray('# Run these commands to check out this PR:'));
  console.log('git fetch ' + remoteUrl + ' ' + branch);
  console.log('git checkout -b ' + branch + ' FETCH_HEAD');
}

// ─── issue list ──────────────────────────────────────────────────────────────

async function issueList(args) {
  const repo = await resolveRepo(args[0]);
  let issues;
  try { issues = await api(`/repos/${repo}/issues?state=open&per_page=30`); }
  catch (e) { fail('issue list', e); }

  const filtered = issues.filter(i => !i.pull_request);
  if (!filtered.length) { console.log(C.gray('No open issues.')); return; }

  const rows = filtered.map(i => [
    C.cyan('#' + i.number),
    trunc(i.title, 60),
    i.labels.map(l => C.yellow(l.name)).join(', '),
  ]);
  console.log(table(rows, [6, 62]));
}

// ─── issue view ──────────────────────────────────────────────────────────────

async function issueView(args) {
  if (!args[0]) die('issue view: issue number required');
  const repo = await resolveRepo(args[1]);
  let issue;
  try { issue = await api(`/repos/${repo}/issues/${args[0]}`); }
  catch (e) { fail('issue view', e); }

  const stateStr = issue.state === 'open' ? C.green('open') : C.red('closed');
  console.log(C.bold(issue.title) + '  ' + sym(issue.state) + ' ' + stateStr);
  console.log(C.gray('Author:') + '  ' + issue.user.login);
  console.log(C.gray('URL:') + '     ' + issue.html_url);
  if (issue.labels.length) console.log(C.gray('Labels:') + '  ' + issue.labels.map(l => C.yellow(l.name)).join(', '));
  if (issue.body) {
    console.log('\n' + C.gray('Body:'));
    console.log(trunc(issue.body.replace(/\r?\n/g, ' '), 400));
  }
}

// ─── repo view ───────────────────────────────────────────────────────────────

async function repoView(args) {
  const repo = await resolveRepo(args[0]);
  let r;
  try { r = await api(`/repos/${repo}`); }
  catch (e) { fail('repo view', e); }

  console.log(C.bold(r.full_name));
  if (r.description) console.log(r.description);
  console.log('');
  console.log(C.gray('Stars:          ') + C.yellow('★') + ' ' + r.stargazers_count);
  console.log(C.gray('Forks:          ') + r.forks_count);
  console.log(C.gray('Default branch: ') + r.default_branch);
  console.log(C.gray('Language:       ') + (r.language || 'unknown'));
  console.log(C.gray('Last push:      ') + fmtDate(r.pushed_at));
  if (r.topics && r.topics.length) console.log(C.gray('Topics:         ') + r.topics.join(', '));
  console.log(C.gray('URL:            ') + r.html_url);
}

// ─── run list ────────────────────────────────────────────────────────────────

async function runList(args) {
  const repo = await resolveRepo(args[0]);
  let runs;
  try {
    const data = await api(`/repos/${repo}/actions/runs?per_page=20`);
    runs = data.workflow_runs;
  } catch (e) { fail('run list', e); }

  if (!runs || !runs.length) { console.log(C.gray('No workflow runs.')); return; }

  const rows = runs.map(run => {
    const statusStr = run.status === 'completed'
      ? sym(run.conclusion) + ' ' + (run.conclusion || 'unknown')
      : sym('in_progress') + ' ' + run.status;
    return [
      C.gray(String(run.id)),
      trunc(run.name, 36),
      statusStr,
      C.gray(trunc(run.head_branch, 28)),
      C.gray(fmtDate(run.created_at)),
    ];
  });
  console.log(table(rows, [14, 38, 22, 30]));
}

// ─── run view ────────────────────────────────────────────────────────────────

async function runView(args) {
  if (!args[0]) die('run view: run ID required');
  const repo = await resolveRepo(args[1]);
  let run, jobsData;
  try { run = await api(`/repos/${repo}/actions/runs/${args[0]}`); }
  catch (e) { fail('run view', e); }
  try { jobsData = await api(`/repos/${repo}/actions/runs/${args[0]}/jobs`); }
  catch { jobsData = { jobs: [] }; }

  const statusStr = run.status === 'completed'
    ? sym(run.conclusion || 'neutral') + ' ' + run.status + ' / ' + (run.conclusion || 'unknown')
    : sym('in_progress') + ' ' + run.status;

  console.log(C.bold(run.name) + '  ' + statusStr);
  console.log(C.gray('Branch:  ') + run.head_branch);
  const msg = run.head_commit && run.head_commit.message
    ? trunc(run.head_commit.message.split('\n')[0], 60) : '';
  console.log(C.gray('Commit:  ') + run.head_sha.slice(0, 7) + (msg ? ' — ' + msg : ''));
  console.log(C.gray('Started: ') + fmtDate(run.created_at));
  console.log(C.gray('URL:     ') + run.html_url);

  const jobs = jobsData.jobs || [];
  if (jobs.length) {
    console.log('\n' + C.bold('Jobs:'));
    for (const job of jobs) {
      const s = job.status === 'completed' ? sym(job.conclusion || 'neutral') : sym('in_progress');
      const dur = (job.completed_at && job.started_at)
        ? C.gray(' (' + Math.round((new Date(job.completed_at) - new Date(job.started_at)) / 1000) + 's)') : '';
      console.log('  ' + s + '  ' + job.name + dur);
    }
  }
}

// ─── release list ────────────────────────────────────────────────────────────

async function releaseList(args) {
  const repo = await resolveRepo(args[0]);
  let releases;
  try { releases = await api(`/repos/${repo}/releases?per_page=15`); }
  catch (e) { fail('release list', e); }

  if (!releases.length) { console.log(C.gray('No releases.')); return; }

  const rows = releases.map(r => [
    C.cyan(trunc(r.tag_name, 24)),
    trunc(r.name || r.tag_name, 48) + (r.prerelease ? C.yellow(' [pre]') : '') + (r.draft ? C.gray(' [draft]') : ''),
    C.gray(fmtDate(r.published_at)),
  ]);
  console.log(table(rows, [26, 56]));
}

// ─── notifications list ───────────────────────────────────────────────────────

const NOTIF_TYPE_SYM = {
  PullRequest: C.cyan('PR'),
  Issue:       C.green('IS'),
  Release:     C.yellow('RL'),
  Commit:      C.gray('CM'),
  Discussion:  C.cyan('DS'),
  CheckSuite:  C.gray('CS'),
  RepositoryVulnerabilityAlert: C.red('VA'),
};

function notifTypeSym(t) { return NOTIF_TYPE_SYM[t] || C.gray(t.slice(0,2).toUpperCase()); }

const NOTIF_REASON_COLOR = {
  mention:       C.yellow,
  author:        C.cyan,
  comment:       C.gray,
  review_requested: C.yellow,
  assign:        C.cyan,
  subscribed:    C.gray,
  team_mention:  C.yellow,
  ci_activity:   C.gray,
  security_alert: C.red,
};

function reasonStr(r) {
  const fn = NOTIF_REASON_COLOR[r] || C.gray;
  return fn(r.replace('_', ' '));
}

async function notificationsList(args) {
  // Parse flags
  let participating = false, repoFilter = null, showAll = false, limit = 30;
  const rest = [];
  for (const a of args) {
    if (a === '--participating' || a === '-p') participating = true;
    else if (a === '--all' || a === '-a') showAll = true;
    else if (a.startsWith('--repo=')) repoFilter = a.slice(7);
    else if (a.startsWith('-n')) limit = parseInt(a.slice(2)) || 30;
    else rest.push(a);
  }
  if (rest[0] && rest[0].includes('/')) repoFilter = rest[0];

  const qs = new URLSearchParams({
    all: showAll ? 'true' : 'false',
    participating: participating ? 'true' : 'false',
    per_page: String(Math.min(limit, 50)),
  });

  let notifs;
  try {
    const endpoint = repoFilter
      ? `/repos/${repoFilter}/notifications?${qs}`
      : `/notifications?${qs}`;
    notifs = await api(endpoint);
  } catch (e) { fail('notifications list', e); }

  if (!notifs.length) { console.log(C.gray('No notifications.')); return; }

  // Group by repo for readability
  const byRepo = {};
  for (const n of notifs) {
    const repo = n.repository.full_name;
    if (!byRepo[repo]) byRepo[repo] = [];
    byRepo[repo].push(n);
  }

  for (const [repo, items] of Object.entries(byRepo)) {
    console.log('\n' + C.bold(repo));
    for (const n of items) {
      const type   = notifTypeSym(n.subject.type);
      const title  = trunc(n.subject.title, 60);
      const reason = reasonStr(n.reason);
      const date   = C.gray(fmtDate(n.updated_at));
      const unread = n.unread ? C.yellow('•') : ' ';
      // Extract PR/issue number from URL if present
      const numMatch = n.subject.url?.match(/\/(pulls|issues)\/(\d+)$/);
      const num = numMatch ? C.gray('#' + numMatch[2]) : '   ';
      console.log('  ' + unread + ' ' + type + ' ' + pad(num, 7) + pad(title, 62) + '  ' + pad(reason, 18) + '  ' + date);
    }
  }
  console.log('');
}

async function notificationsRead(args) {
  // Mark notifications as read — all or for a specific repo
  let repoFilter = null;
  for (const a of args) {
    if (a.includes('/')) repoFilter = a;
    else if (a.startsWith('--repo=')) repoFilter = a.slice(7);
  }

  try {
    const endpoint = repoFilter
      ? `/repos/${repoFilter}/notifications`
      : `/notifications`;
    await api(endpoint, { method: 'PUT', body: JSON.stringify({ read: true }) });
    console.log(sym('success') + ' Marked ' + (repoFilter ? C.cyan(repoFilter) : 'all') + ' notifications as read');
  } catch (e) { fail('notifications read', e); }
}

// ─── search prs ──────────────────────────────────────────────────────────────

async function searchPrs(args) {
  if (!args[0]) die('search prs: query required');
  const repo = args[1] || await inferRepo();
  const q = args[0] + ' type:pr' + (repo ? ' repo:' + repo : '');
  let results;
  try {
    const data = await api('/search/issues?q=' + encodeURIComponent(q) + '&per_page=20');
    results = data.items;
  } catch (e) { fail('search prs', e); }

  if (!results.length) { console.log(C.gray('No matching PRs.')); return; }

  const rows = results.map(item => [
    C.cyan('#' + item.number),
    trunc(item.title, 56),
    C.gray(item.repository_url.replace('https://api.github.com/repos/', '')),
    item.state === 'open' ? C.green('open') : C.red(item.state),
  ]);
  console.log(table(rows, [6, 58, 36]));
}

// ─── vars list ───────────────────────────────────────────────────────────────

async function varsList(args) {
  const repo = await resolveRepo(args[0]);
  let vars;
  try {
    const data = await api(`/repos/${repo}/actions/variables?per_page=30`);
    vars = data.variables;
  } catch (e) { fail('vars list', e); }

  if (!vars || !vars.length) { console.log(C.gray('No variables.')); return; }

  const rows = vars.map(v => [C.cyan(trunc(v.name, 32)), trunc(v.value, 60)]);
  console.log(table(rows, [36]));
}

// ─── vars set ────────────────────────────────────────────────────────────────

async function varsSet(args) {
  if (!args[0]) die('vars set: name required');
  if (args[1] === undefined) die('vars set: value required');
  const repo = await resolveRepo(args[2]);
  const name = args[0], value = args[1];

  let exists = false;
  try { await api(`/repos/${repo}/actions/variables/${name}`); exists = true; } catch {}

  try {
    if (exists) {
      await api(`/repos/${repo}/actions/variables/${name}`, {
        method: 'PATCH', body: JSON.stringify({ name, value }),
      });
    } else {
      await api(`/repos/${repo}/actions/variables`, {
        method: 'POST', body: JSON.stringify({ name, value }),
      });
    }
    console.log(sym('success') + ' Variable ' + C.cyan(name) + ' ' + (exists ? 'updated' : 'created'));
  } catch (e) { fail('vars set', e); }
}

// ─── auth status ─────────────────────────────────────────────────────────────

async function authStatus() {
  const src = _tokenResult.stdout.trim() ? 'git config github.token' : 'env $GITHUB_TOKEN';
  const preview = token ? token.slice(0, 8) + '…' : C.red('(not set)');
  let username = C.gray('(unverified)');
  if (token) {
    try {
      const u = await api('/user', { headers: { 'Authorization': `Bearer ${token}` } });
      username = u.login;
    } catch { username = C.red('(invalid token)'); }
  }

  let botStatus = C.gray('not cached — will prompt on first write op');
  try {
    const cached = (await fs.readFile(BOT_CACHE)).trim();
    if (cached) {
      const check = await fetch('https://api.github.com/user', {
        headers: { 'Authorization': `Bearer ${cached}`, 'User-Agent': 'gh.jsh/1.0' }
      });
      if (check.ok) {
        const bu = await check.json();
        botStatus = C.green('valid') + ' — acting as ' + C.cyan(bu.login);
      } else {
        botStatus = C.yellow('cached but expired — will re-auth on next write op');
      }
    }
  } catch {}

  const writeList = Object.entries(WRITE_OPS)
    .flatMap(([k, vs]) => vs.map(v => `${k}:${v}`)).join(', ');

  console.log(C.bold('\nPersonal token'));
  console.log('  Source:  ' + C.gray(src));
  console.log('  Token:   ' + C.cyan(preview));
  console.log('  User:    ' + C.cyan(username));
  console.log(C.bold('\nAI attribution'));
  console.log('  Enabled: ' + (isAI ? C.green('yes') : C.gray('no (not running as AI agent)')));
  console.log('  Broker:  ' + C.gray(BROKER_URL));
  console.log('  Bot token: ' + botStatus);
  console.log(C.bold('\nWrite operations that trigger attribution:'));
  console.log('  ' + C.gray(writeList));
  console.log('');
}

// ─── help ────────────────────────────────────────────────────────────────────

function showHelp() {
  console.log(C.bold('gh.jsh') + ' — GitHub CLI for SLICC agents\n');
  console.log(C.bold('USAGE'));
  console.log('  gh <command> <subcommand> [args] [owner/repo]\n');
  console.log(C.bold('COMMANDS'));
  console.log('  ' + C.cyan('pr list') + '       [repo]                       List open pull requests');
  console.log('  ' + C.cyan('pr view') + '       <num> [repo]                 View PR details and checks');
  console.log('  ' + C.cyan('pr merge') + '      <num> [--squash|--rebase] [repo]  Merge a PR');
  console.log('  ' + C.cyan('pr comment') + '    <num> <message> [repo]       Post a comment');
  console.log('  ' + C.cyan('pr checkout') + '   <num> [repo]                 Print checkout commands');
  console.log('  ' + C.cyan('issue list') + '    [repo]                       List open issues');
  console.log('  ' + C.cyan('issue view') + '    <num> [repo]                 View issue details');
  console.log('  ' + C.cyan('repo view') + '     [repo]                       Show repository info');
  console.log('  ' + C.cyan('run list') + '      [repo]                       List recent workflow runs');
  console.log('  ' + C.cyan('run view') + '      <run_id> [repo]              View run details and jobs');
  console.log('  ' + C.cyan('release list') + '  [repo]                       List recent releases');
  console.log('  ' + C.cyan('search prs') + '    <query> [repo]               Search PRs by keyword');
  console.log('  ' + C.cyan('vars list') + '     [repo]                       List Actions variables');
  console.log('  ' + C.cyan('vars set') + '      <name> <value> [repo]        Set an Actions variable');
  console.log('  ' + C.cyan('notifications list') + '  [--all] [-p] [--repo=r] [-nN]  List notifications');
  console.log('  ' + C.cyan('notifications read') + '  [--repo=r]              Mark notifications as read\n');
  console.log(C.bold('AUTH'));
  console.log('  git config github.token <PAT>');
  console.log('  — or: export GITHUB_TOKEN=<PAT>\n');
  console.log(C.bold('REPO'));
  console.log('  Defaults to current git remote origin. Pass owner/repo to override.');
}

// ─── Router ───────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const cmd  = argv[0];
const sub  = argv[1];
const rest = argv.slice(2);

if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
  showHelp();
  process.exit(0);
}

if (cmd === 'auth') { await authStatus(); process.exit(0); }

const dispatch = {
  pr:      { list: () => prList(rest),      view: () => prView(rest),    merge: () => prMerge(rest), comment: () => prComment(rest), checkout: () => prCheckout(rest) },
  issue:   { list: () => issueList(rest),   view: () => issueView(rest) },
  repo:    { view: () => repoView(rest) },
  run:     { list: () => runList(rest),     view: () => runView(rest) },
  release: { list: () => releaseList(rest) },
  search:  { prs:  () => searchPrs(rest) },
  vars:    { list: () => varsList(rest),    set:  () => varsSet(rest) },
  notifications: { list: () => notificationsList(rest), read: () => notificationsRead(rest) },
};

if (!dispatch[cmd]) die("unknown command: '" + cmd + "'. Run gh --help for usage.");
if (!sub || !dispatch[cmd][sub]) die("unknown subcommand: '" + cmd + ' ' + (sub || '') + "'. Run gh --help for usage.");

try {
  await dispatch[cmd][sub]();
} catch (err) {
  die(cmd + ' ' + sub + ' failed: ' + err.message);
}
