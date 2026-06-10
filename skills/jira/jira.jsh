// jira.jsh — Jira CLI via browser SSO session
// Usage: jira <command> [args]
//   jira detect
//   jira whoami
//   jira get <issue-key>
//   jira search "<jql>"
//   jira comments <issue-key>
//   jira create --project <key> --type <type> --summary <text> [--description <text>] [--assignee <name>]

// --- Tab management ---

let _tab = null;
let _jiraBase = null;

async function findJiraTab() {
  if (_tab) return _tab;
  _tab = await browser.findTab({ urlMatch: /jira/ });
  if (!_tab) {
    cli.die('No Jira tab found. Open Jira in your browser and try again.');
  }
  _jiraBase = new URL(_tab.url).origin;
  return _tab;
}

// --- API helpers ---

// Raw fetch — returns the full response; caller checks resp.ok
async function jiraGetRaw(path) {
  const tab = await findJiraTab();
  return browser.fetch(tab, _jiraBase + path);
}

// Fetch and throw on non-2xx
async function jiraGet(path) {
  const resp = await jiraGetRaw(path);
  if (!resp.ok) {
    cli.die(`API error ${resp.status}. Is your Jira session active? (Refresh the Jira tab if needed.)`);
  }
  return resp.body;
}

async function jiraPost(path, body) {
  const tab = await findJiraTab();
  const resp = await browser.fetch(tab, _jiraBase + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  return resp;
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
  console.log(`Found Jira tab: ${c.cyan(_jiraBase)}`);
  console.log('Please confirm this is the correct Jira instance before proceeding.');
}

async function whoami() {
  const data = await jiraGet('/rest/api/2/myself');
  console.log(`Authenticated as: ${c.bold(data.displayName)} (${data.emailAddress})`);
}

async function get(key) {
  if (!key) cli.die('Usage: jira get <issue-key>');
  const data = await jiraGet(`/rest/api/2/issue/${key}`);
  const f = data.fields;
  const out = [
    `${c.bold(data.key)}: ${f.summary}`,
    `  Type:        ${f.issuetype?.name || ''}`,
    `  Status:      ${f.status?.name || ''}`,
    `  Assignee:    ${f.assignee?.displayName || c.dim('Unassigned')}`,
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
    out.push(`    ${c.dim('(none)')}`);
  }
  console.log(out.join('\n'));
}

async function search(jql) {
  if (!jql) cli.die('Usage: jira search "<jql>"');
  const encoded = encodeURIComponent(jql);
  const data = await jiraGet(`/rest/api/2/search?jql=${encoded}&maxResults=50&fields=summary,status,assignee,issuetype`);
  const issues = data.issues || [];
  console.log(`${c.bold(String(data.total))} issue(s) found (showing ${issues.length}):\n`);
  issues.forEach(i => {
    const status = i.fields.status?.name || '';
    console.log(`  ${c.cyan(i.key)}: ${i.fields.summary} ${c.dim('[' + status + ']')}`);
  });
}

async function comments(key) {
  if (!key) cli.die('Usage: jira comments <issue-key>');
  const data = await jiraGet(`/rest/api/2/issue/${key}/comment`);
  const items = data.comments || [];
  console.log(`Comments on ${c.bold(key)} (${items.length}):\n`);
  items.forEach(comment => {
    console.log(`  ${c.dim('[' + fmtDate(comment.created) + ']')} ${c.bold(comment.author?.displayName || 'Unknown')}:`);
    stripWiki(comment.body).split('\n').slice(0, 20).forEach(l => console.log(`    ${l}`));
    console.log('');
  });
}

async function components(project) {
  if (!project) cli.die('Usage: jira components <project-key>');
  const resp = await jiraGetRaw(`/rest/api/2/project/${project}/components`);
  if (!resp.ok) cli.die(`Could not fetch components for project "${project}" (${resp.status})`);
  const items = resp.body ?? [];
  if (!items.length) { console.log(`No components defined for ${project}.`); return; }
  console.log(`Components for ${c.bold(project)} (${items.length}):\n`);
  items.sort((a, b) => a.name.localeCompare(b.name))
       .forEach(item => console.log(`  ${item.name}${item.description ? c.dim(' — ' + item.description) : ''}`));
}

async function types(project) {
  if (!project) cli.die('Usage: jira types <project-key>');
  // Try paginated endpoint first, fall back to classic
  const paged = await jiraGetRaw(`/rest/api/2/issue/createmeta/${project}/issuetypes`);
  let items;
  if (paged.ok) {
    items = paged.body.values ?? [];
  } else {
    const classic = await jiraGetRaw(`/rest/api/2/issue/createmeta?projectKeys=${project}&expand=projects.issuetypes`);
    if (!classic.ok) cli.die(`Could not fetch issue types for project "${project}" (${classic.status})`);
    items = classic.body.projects?.[0]?.issuetypes ?? [];
  }
  if (!items.length) { console.log(`No issue types found for ${project}.`); return; }
  console.log(`Issue types for ${c.bold(project)} (${items.length}):\n`);
  items.sort((a, b) => a.name.localeCompare(b.name))
       .forEach(item => console.log(`  ${item.name}${item.description ? c.dim(' — ' + item.description) : ''}`));
}

async function labels(project) {
  if (!project) cli.die('Usage: jira labels <project-key>');
  const [projectResp, instanceResp] = await Promise.all([
    jiraGetRaw(`/rest/api/2/search?jql=${encodeURIComponent(`project=${project} AND labels is not EMPTY`)}&maxResults=100&fields=labels`),
    jiraGetRaw(`/rest/api/1.0/labels/suggest?query=&maxResults=100`),
  ]);
  if (!projectResp.ok) cli.die(`Could not fetch labels for project "${project}" (${projectResp.status})`);

  const projectLabels = new Set();
  for (const issue of projectResp.body.issues ?? []) {
    for (const label of issue.fields.labels ?? []) projectLabels.add(label);
  }

  const instanceLabels = new Set();
  if (instanceResp.ok) {
    for (const s of instanceResp.body.suggestions ?? []) instanceLabels.add(s.label);
  }

  const allLabels = [...new Set([...projectLabels, ...instanceLabels])].sort();
  if (!allLabels.length) { console.log(`No labels found.`); return; }

  console.log(`Labels for ${c.bold(project)}:\n`);
  if (projectLabels.size) {
    console.log(c.bold(`  Used in this project (${projectLabels.size}):`));
    [...projectLabels].sort().forEach(l => console.log(`    ${l}`));
  }
  const instanceOnly = allLabels.filter(l => !projectLabels.has(l));
  if (instanceOnly.length) {
    console.log(c.dim(`\n  Instance-wide (${instanceOnly.length}):`));
    instanceOnly.forEach(l => console.log(c.dim(`    ${l}`)));
  }
}

async function create(flags) {
  const project = flags.project;
  const issueType = flags.type;

  if (!project) cli.die('--project is required (e.g. jira create --project PROJ --type Story --summary "...")');
  if (!issueType) cli.die('--type is required (e.g. Story, Bug, Task)');

  // Fetch createmeta — try multiple endpoint shapes in order:
  //   1. Paginated (Jira Server 9+ / Data Center): GET /createmeta/{project}/issuetypes
  //   2. Classic (Jira Server <9 / older DC):       GET /createmeta?projectKeys=…&expand=…
  // Both return the same logical data; we normalise to { allTypes, getFields(typeId) }.

  let allTypes = [];
  let getFields; // async (typeId) => Record<fieldId, fieldMeta>

  const paginatedTypesResp = await jiraGetRaw(`/rest/api/2/issue/createmeta/${project}/issuetypes`);

  if (paginatedTypesResp.ok) {
    // Shape 1 — paginated
    allTypes = paginatedTypesResp.body.values ?? [];
    getFields = async (typeId) => {
      const fd = await jiraGet(`/rest/api/2/issue/createmeta/${project}/issuetypes/${typeId}`);
      return Object.fromEntries((fd.values ?? []).map(f => [f.fieldId, f]));
    };
  } else {
    // Shape 2 — classic expand
    const classicResp = await jiraGetRaw(
      `/rest/api/2/issue/createmeta?projectKeys=${project}&issuetypeNames=${encodeURIComponent(issueType)}&expand=projects.issuetypes.fields`
    );
    if (!classicResp.ok) {
      cli.die(`Could not fetch createmeta for project "${project}" (tried both endpoint variants). Status: ${classicResp.status}`);
    }
    const projectMeta = classicResp.body.projects?.[0];
    if (!projectMeta) {
      cli.die(`Project "${project}" not found or you don't have permission to create issues there.`);
    }
    // Normalise classic issuetypes into the same shape
    allTypes = projectMeta.issuetypes ?? [];
    getFields = async (typeId) => {
      const typeMeta = allTypes.find(t => t.id === typeId);
      return typeMeta?.fields ?? {};
    };
  }

  if (!allTypes.length) {
    cli.die(`Project "${project}" not found or you don't have permission to create issues there.`);
  }

  const matchedType = allTypes.find(t => t.name.toLowerCase() === issueType.toLowerCase());
  if (!matchedType) {
    console.error(`Issue type "${issueType}" not found in project ${project}.`);
    console.error(`Available types: ${allTypes.map(t => t.name).join(', ')}`);
    process.exit(1);
  }

  const rawFields = await getFields(matchedType.id);
  const typeMeta = { fields: rawFields };

  // Build the fields object — start with what was passed
  const fields = {
    project: { key: project },
    issuetype: { name: issueType },
  };

  // Map flag names to Jira field names
  const fieldMap = {
    summary: 'summary',
    description: 'description',
    assignee: 'assignee',
    priority: 'priority',
    labels: 'labels',
    components: 'components',
  };

  // Attribution footer (appended to description)
  const attribution = '\n\n----\n_Created with sliccy (ai-ecoverse/skills@0.2.5)_';

  // Apply provided flags
  if (flags.summary)     fields.summary = flags.summary;
  if (flags.description) fields.description = flags.description + attribution;
  else                   fields.description = attribution.trim();
  if (flags.assignee)    fields.assignee = { name: flags.assignee };
  if (flags.priority)    fields.priority = { name: flags.priority };
  if (flags.labels)      fields.labels = flags.labels.split(',').map(l => l.trim());
  if (flags.components)  fields.components = flags.components.split(',').map(n => ({ name: n.trim() }));

  // Check required fields from createmeta
  const requiredFields = Object.entries(typeMeta.fields ?? {})
    .filter(([, v]) => v.required)
    .map(([k, v]) => ({ id: k, name: v.name, schema: v.schema }));

  const missing = [];
  for (const req of requiredFields) {
    const id = req.id;
    // 'summary' maps directly; others need checking
    if (id === 'summary' && !fields.summary) {
      missing.push(req);
    } else if (id === 'issuetype' || id === 'project') {
      // already set
    } else if (!(id in fields)) {
      // Check if a flag alias covered it
      const aliasKey = Object.entries(fieldMap).find(([, v]) => v === id)?.[0];
      if (aliasKey && flags[aliasKey]) {
        // covered
      } else {
        missing.push(req);
      }
    }
  }

  if (missing.length > 0) {
    // For fields with a known allowed-values list (components, priority, etc.),
    // try to help the user pick rather than just failing.
    const unresolved = [];

    for (const req of missing) {
      const fieldMeta = typeMeta.fields[req.id];

      if (req.id === 'components') {
        // Fetch project components and suggest likely matches
        const compResp = await jiraGetRaw(`/rest/api/2/project/${project}/components`);
        const allComponents = compResp.ok ? (compResp.body ?? []) : [];
        const names = allComponents.map(c => c.name);

        if (names.length === 0) {
          unresolved.push(req);
          continue;
        }

        // Score components against summary + description for likely candidates
        const text = ((fields.summary || '') + ' ' + (fields.description || '')).toLowerCase();
        const scored = names.map(name => {
          const words = name.toLowerCase().split(/\W+/);
          const score = words.reduce((n, w) => n + (w.length > 2 && text.includes(w) ? 1 : 0), 0);
          return { name, score };
        }).sort((a, b) => b.score - a.score);

        const suggestions = scored.filter(s => s.score > 0);
        const others = scored.filter(s => s.score === 0);

        console.log(c.yellow(`\nRequired: Component/s`));
        console.log('Available components for this project:\n');
        if (suggestions.length) {
          console.log(c.bold('  Likely matches (based on issue content):'));
          suggestions.forEach((s, i) => console.log(`    ${c.cyan(String(i + 1))}. ${s.name}`));
          if (others.length) {
            console.log(c.dim('\n  Other components:'));
            others.forEach((s, i) => console.log(c.dim(`    ${i + suggestions.length + 1}. ${s.name}`)));
          }
        } else {
          names.forEach((name, i) => console.log(`    ${c.cyan(String(i + 1))}. ${name}`));
        }

        const allOrdered = [...suggestions.map(s => s.name), ...others.map(s => s.name)];
        console.log('');
        console.error('\nRe-run with: --components "<name>"');
        process.exit(1);

      } else if (fieldMeta?.allowedValues?.length) {
        // Generic allowed-values prompt for other required fields
        const values = fieldMeta.allowedValues.map(v => v.name ?? v.value ?? v.id);
        console.error(c.yellow(`\nRequired: ${req.name}`));
        values.forEach((v, i) => console.error(`  ${c.cyan(String(i + 1))}. ${v}`));
        console.error(`\nRe-run with: --field-${req.id} "<value>"`);
        process.exit(1);

      } else {
        unresolved.push(req);
      }
    }

    if (unresolved.length > 0) {
      console.error(c.red('\nStill missing required fields:\n'));
      unresolved.forEach(f => {
        const hint = f.schema?.type ? ` (${f.schema.type})` : '';
        console.error(`  ${c.bold(f.name)}${c.dim(hint)}  →  pass as --${f.id.replace(/customfield_/, 'cf-')}`);
      });
      console.error('');
      console.error('Re-run with the missing fields. For custom fields, use --cf-NNNNN or pass the raw field ID via --field-<id>=<value>.');
      process.exit(1);
    }
  }

  // Always surface label options if not supplied — optional but useful.
  // Pass --no-labels to explicitly skip.
  if (!flags.labels && !flags['no-labels']) {
    // Fetch two sources and merge:
    //   1. Instance-wide label suggest (broad universe, up to 100)
    //   2. Labels already used in this project (used to boost weight)
    const [instanceResp, projectResp] = await Promise.all([
      jiraGetRaw(`/rest/api/1.0/labels/suggest?query=&maxResults=100`),
      jiraGetRaw(`/rest/api/2/search?jql=${encodeURIComponent(`project=${project} AND labels is not EMPTY`)}&maxResults=100&fields=labels`),
    ]);

    const projectLabels = new Set();
    if (projectResp.ok) {
      for (const issue of projectResp.body.issues ?? []) {
        for (const label of issue.fields.labels ?? []) projectLabels.add(label);
      }
    }

    const allLabels = new Set(projectLabels);
    if (instanceResp.ok) {
      for (const s of instanceResp.body.suggestions ?? []) allLabels.add(s.label);
    }

    const knownLabels = [...allLabels].sort();

    if (knownLabels.length) {
      const text = ((fields.summary || '') + ' ' + (fields.description || '')).toLowerCase();
      const scored = knownLabels.map(name => {
        const words = name.toLowerCase().split(/\W+/);
        const contentScore = words.reduce((n, w) => n + (w.length > 2 && text.includes(w) ? 1 : 0), 0);
        const projectBoost = projectLabels.has(name) ? 2 : 0; // labels used in this project rank higher
        return { name, score: contentScore + projectBoost, inProject: projectLabels.has(name) };
      }).sort((a, b) => b.score - a.score);

      const suggestions = scored.filter(s => s.score > 0);
      const others = scored.filter(s => s.score === 0);

      console.log(c.yellow('\nOptional: Labels'));
      console.log('Labels in use in this project:\n');
      if (suggestions.length) {
        console.log(c.bold('  Likely matches:'));
        suggestions.forEach((s, i) => console.log(`    ${c.cyan(String(i + 1))}. ${s.name}${s.inProject ? c.dim(' (used in project)') : ''}`));
        if (others.length) {
          console.log(c.dim('\n  Other labels:'));
          others.forEach((s, i) => console.log(c.dim(`    ${i + suggestions.length + 1}. ${s.name}${s.inProject ? ' (used in project)' : ''}`)));
        }
      } else {
        scored.forEach((s, i) => console.log(`    ${c.cyan(String(i + 1))}. ${s.name}${s.inProject ? c.dim(' (used in project)') : ''}`));
      }

      console.log(c.dim('\nRe-run with --labels "<name>,<name>" to set labels, or --no-labels to skip.'));
      process.exit(1);
    }
  }

  // Handle raw --field-<id>=<value> overrides for custom fields
  for (const [k, v] of Object.entries(flags)) {
    if (k.startsWith('field-')) {
      fields[k.slice(6)] = v;
    } else if (k.startsWith('cf-')) {
      fields[`customfield_${k.slice(3)}`] = v;
    }
  }

  // Dry-run: show what would be posted without sending
  if (flags['dry-run'] || flags['dry_run'] || flags.dry) {
    console.log(c.yellow('Dry run — would POST to /rest/api/2/issue:'));
    console.log(JSON.stringify({ fields }, null, 2));
    process.exit(0);
  }

  // POST the new issue
  const resp = await jiraPost('/rest/api/2/issue', { fields });

  if (!resp.ok) {
    const body = resp.body;
    const errors = body?.errors ? Object.entries(body.errors).map(([k, v]) => `  ${k}: ${v}`).join('\n') : '';
    const messages = body?.errorMessages?.join('\n  ') ?? '';
    console.error(c.red(`Failed to create issue (${resp.status}):`));
    if (errors)   console.error(errors);
    if (messages) console.error('  ' + messages);
    process.exit(1);
  }

  const created = resp.body;
  console.log(`${c.green('✓')} Created ${c.bold(created.key)}: ${_jiraBase}/browse/${created.key}`);
}

// --- Main ---

const { positional, flags } = process.argv.parseFlags();
const [cmd] = positional;

const HELP = `
Jira CLI — interact with Jira via the browser SSO session.

Usage: jira <command> [args]

Commands:
  detect                         Find the Jira tab and confirm the instance URL
  whoami                         Verify auth — prints logged-in user
  get <issue-key>                Fetch a single issue with full detail
  search "<jql>"                 Run a JQL query (up to 50 results)
  comments <issue-key>           Fetch all comments on an issue
  components <project-key>       List all components defined in a project
  types <project-key>            List all issue types available in a project
  labels <project-key>           List all labels in use in a project
  create                         Create a new issue (discovers required fields automatically)

create flags:
  --project  <key>               Project key (required)
  --type     <name>              Issue type name (required, e.g. Story, Bug, Task)
  --summary  <text>              Issue summary (required for most types)
  --description <text>           Issue description
  --assignee <username>          Assignee username
  --priority <name>              Priority name (e.g. High, Medium, Low)
  --labels   <a,b,c>             Comma-separated labels
  --components <a,b>             Comma-separated component names
  --cf-NNNNN <value>             Set a custom field by numeric ID (e.g. --cf-10014 sprint-1)
  --field-<id> <value>           Set any field by its raw Jira field ID

Notes:
  - Run 'jira create --project PROJ --type Story' with no --summary to see
    all required fields for that project + type before committing.
  - Required fields vary per project and issue type; the command fetches
    createmeta automatically and reports what's missing.
`.trim();

if (!cmd || cmd === 'help' || cmd === '--help') {
  console.log(HELP);
  process.exit(0);
}

switch (cmd) {
  case 'detect':     await detect(); break;
  case 'whoami':     await whoami(); break;
  case 'get':        await get(positional[1]); break;
  case 'search':     await search(positional.slice(1).join(' ') || flags._); break;
  case 'comments':   await comments(positional[1]); break;
  case 'components': await components(positional[1]); break;
  case 'types':      await types(positional[1]); break;
  case 'labels':     await labels(positional[1]); break;
  case 'create':     await create(flags); break;
  default:
    cli.die(`Unknown command: ${cmd}\nRun "jira help" for usage.`);
}
