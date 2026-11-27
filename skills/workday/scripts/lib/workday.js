// workday.js — parse the JSON that Workday's own web client gets from its
// UI backend (the `.htmld` endpoints), for workday.jsh. Pure functions only:
// no I/O, so tests feed them fixtures. Shapes captured live 2026-11-25.

// Instance IDs are `<class>$<number>`: 247$… is a worker, 2500$… a
// supervisory organization, 2998$… a task. Only these go into a URL path.
const INSTANCE_ID = /^\d+\$\d+$/;
// A same-origin path the backend handed us (View Team link, chunk URL).
const SERVER_PATH = /^\/[A-Za-z0-9_-]+\/[A-Za-z0-9_$./-]+$/;

const clean = (s) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '');

// https://wd3.myworkday.com/acme/d/home.htmld → { origin, tenant: 'acme' }
function tenantFromUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch (_) {
    return null;
  }
  if (u.protocol !== 'https:' || !/(^|\.)myworkday\.com$/.test(u.hostname)) return null;
  const tenant = u.pathname.split('/')[1] || '';
  if (!/^[A-Za-z0-9_-]+$/.test(tenant) || tenant === 'wday') return null;
  return { origin: u.origin, tenant };
}

// Depth-first search through a widget tree.
function find(node, pred) {
  if (!node || typeof node !== 'object') return null;
  if (pred(node)) return node;
  for (const v of Object.values(node)) {
    const hit = find(v, pred);
    if (hit) return hit;
  }
  return null;
}

const byProperty = (name) => (o) => o.propertyName === name;
const monikers = (list) =>
  ((list && list.instances) || [])
    .filter((m) => m && m.instanceId)
    .map((m) => ({ id: m.instanceId, name: clean(m.text) }));

// Workday answers many errors with HTTP 200 and an XML body:
// <wml:System_Error …><wml:Message>Missing Required Parm: …</wml:Message>
// A sign-in or error page comes back as HTML. Returns null for anything else.
function workdayError(body) {
  if (typeof body !== 'string') return null;
  const xml =
    /<wml:(System_Error|Application_Error)\b[\s\S]*?<wml:Message>([\s\S]*?)<\/wml:Message>/.exec(
      body
    );
  if (xml) return { kind: 'workday', message: clean(xml[2]) };
  if (/^\s*(<!DOCTYPE|<html)/i.test(body)) return { kind: 'html', message: 'got an HTML page' };
  return null;
}

// GET /<tenant>/home.htmld → the signed-in worker.
function currentUser(root) {
  const u = root && root.currentUser;
  if (!u || !INSTANCE_ID.test(u.iid || '')) return null;
  const self = u.selfLink && typeof u.selfLink.uri === 'string' ? u.selfLink.uri : '';
  return { id: u.iid, name: clean(u.label), profilePath: SERVER_PATH.test(self) ? self : null };
}

// GET /<tenant>/search.htmld?q=…&autocomplete=true → people only. The same
// list also holds tasks, organizations and reports; workers carry the user icon.
function searchPeople(json) {
  const items = (json && json.listItems) || [];
  return items
    .filter((i) => i && INSTANCE_ID.test(i.instanceId || ''))
    .filter(
      (i) =>
        i.iconId === 'wd-icon-user' || /^(Employee|Contingent Worker)$/.test(i.classLabel || '')
    )
    .map((i) => ({
      id: i.instanceId,
      name: clean(i.label),
      title: clean(i.subtitle1),
      org: clean(i.subtitle2),
      location: clean(i.subtitle3),
      kind: clean(i.classLabel),
      profilePath: SERVER_PATH.test(i.uri || '') ? i.uri : null,
    }));
}

// Pick one person for a name: an exact name match, else the only hit.
function choosePerson(query, people) {
  const q = clean(query).toLowerCase();
  const exact = people.filter((p) => p.name.toLowerCase() === q);
  if (exact.length === 1) return { person: exact[0] };
  if (people.length === 1) return { person: people[0] };
  if (!people.length) return { error: `no one in Workday matches "${clean(query)}"` };
  const pool = exact.length ? exact : people;
  return {
    error: `"${clean(query)}" matches ${pool.length} people; pass an id instead`,
    candidates: pool,
  };
}

// GET /<tenant>/inst/<ctx>/<worker>.htmld → a worker profile.
function parseProfile(root) {
  const body = root && root.body;
  if (!body || body.widget !== 'profile') return null;
  const title = (root.title && root.title.instances && root.title.instances[0]) || {};
  const contact = find(body, (o) => o.widget === 'contactLayout') || {};
  const managers = monikers(find(body, byProperty('wd:Manager_For_Position--IS')));
  const location = monikers(find(body, byProperty('wd:Location_Not_Secured--IS')))[0];
  const team = find(body, byProperty('wd:View_Team'));
  const org = clean(contact.organization);
  return {
    id: INSTANCE_ID.test(title.instanceId || '') ? title.instanceId : null,
    name: clean(title.text) || clean(`${contact.firstName || ''} ${contact.lastName || ''}`),
    title: clean(contact.businessTitle),
    email: clean(contact.primaryEmail),
    location: location ? location.name : '',
    managers,
    orgPath: org ? org.split('>>').map(clean).filter(Boolean) : [],
    teamPath: team && SERVER_PATH.test(team.uri || '') ? team.uri : null,
  };
}

// One card of the org chart: a person (leaf) or an organization.
function node(detail) {
  if (!detail || typeof detail !== 'object') return null;
  const inst = ((detail.navigatorInstance && detail.navigatorInstance.instances) || [])[0] || {};
  const items = detail.navigatorItems || [];
  const first = items[0] || {};
  const owners = items.flatMap((i) => monikers(i.owner));
  const leaf = detail.leaf === true || /^247\$/.test(inst.instanceId || '');
  return {
    id: inst.instanceId || '',
    name: clean(inst.text),
    kind: leaf ? 'person' : 'org',
    owners,
    title: clean(first.detailOne),
    location: clean(first.detailTwo),
    size: Number.isFinite(detail.childrenAndPeersCount) ? detail.childrenAndPeersCount : null,
  };
}

// GET the profile's View Team link → the hierarchy navigator: the team the
// worker leads, else the team they are on, with its chain of parent orgs.
function parseTeamPage(root) {
  const body = root && root.body;
  if (!body || body.widget !== 'hierarchyNavigator') return null;
  const inst = ((body.navigatorInstance && body.navigatorInstance.instances) || [])[0] || {};
  return {
    orgId: INSTANCE_ID.test(inst.instanceId || '') ? inst.instanceId : null,
    orgName: clean(inst.text),
    taskId: INSTANCE_ID.test(body.taskIid || '') ? body.taskIid : null,
    navigationPath: SERVER_PATH.test(body.navigationUri || '') ? body.navigationUri : null,
    ancestors: (body.ancestors || []).map(node).filter(Boolean),
  };
}

// POST <navigationUri>/<org>.htmld (initial-step=<taskId>) → PARENT, SELF and
// CHILD_NODES_AND_LEAVES. Children past the first page come from chunkPath.
function parseNavigator(root) {
  const containers = (root && root.body && root.body.navigatorContainers) || null;
  if (!Array.isArray(containers)) return null;
  const of = (type) => containers.find((c) => c && c.navigatorContainerNodeType === type) || {};
  const kids = of('CHILD_NODES_AND_LEAVES');
  const children = (kids.navigatorDetails || []).map(node).filter(Boolean);
  return {
    parent: node((of('PARENT').navigatorDetails || [])[0]),
    self: node((of('SELF').navigatorDetails || [])[0]),
    children,
    total: Number.isFinite(kids.count) ? kids.count : children.length,
    chunkPath: SERVER_PATH.test(kids.chunkingUrl || '') ? kids.chunkingUrl : null,
  };
}

// GET <chunkPath>.htmld?startRow=N&maxRows=M → { totalCount, navigatorDetails }
function parseChunk(json) {
  if (!json || json.widget !== 'navigatorDetailsChunk') return null;
  return {
    total: Number.isFinite(json.totalCount) ? json.totalCount : null,
    children: (json.navigatorDetails || []).map(node).filter(Boolean),
  };
}

// The management chain, nearest manager first: the owner of the worker's
// team (unless that is the worker), then the owners of each parent org.
function chainOf(workerId, team, self) {
  const levels = [];
  if (self) levels.push(self);
  levels.push(...team.ancestors);
  const out = [];
  for (const org of levels) {
    for (const o of org.owners) {
      if (o.id === workerId) continue;
      if (out.some((p) => p.id === o.id)) continue;
      out.push({ id: o.id, name: o.name, title: org.title, org: org.name, orgId: org.id });
    }
  }
  return out;
}

// ── rate limit ────────────────────────────────────────────────────────
// Workday answers a burst of requests with HTTP 200 and
// <wml:Application_Error Type="Validation"><wml:Message>Too many repeating
// requests. Please try again later.</wml:Message></wml:Application_Error>.
// Only this message is a reason to wait and retry; other errors are final.
function isRateLimited(body) {
  const problem = workdayError(body);
  return (
    !!problem &&
    problem.kind === 'workday' &&
    /^Too many repeating requests\b/i.test(problem.message)
  );
}

// "15s", "500ms", "1h", "2d", "90" (seconds) → milliseconds, else null.
function parseDuration(text) {
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/i.exec(
    String(text === undefined ? '' : text).trim()
  );
  if (!m) return null;
  const unit = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 }[(m[2] || 's').toLowerCase()];
  return Math.round(Number(m[1]) * unit);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const now = () => Date.now();

function requestId() {
  return require('crypto').randomBytes(16).toString('hex');
}

function parseKeepalive(body) {
  if (typeof body !== 'string') return null;
  const m = /<(?:[A-Za-z]+:)?Keepalive_Response\b([^>]*)>/.exec(body);
  if (!m) return null;
  const t = /Session_Timeout_Minutes="(\d+)"/.exec(m[1]);
  return { minutes: t ? Number(t[1]) : null };
}

function keepaliveInterval(timeoutMinutes) {
  if (!Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0) return 5 * 60000;
  return Math.max(60000, Math.floor(timeoutMinutes / 3) * 60000);
}

function sessionGone(status, body) {
  if (status === 401 || status === 403) return `HTTP ${status}`;
  const problem = workdayError(body);
  if (problem && problem.kind === 'html') return 'sign-in page';
  if (problem) return `XML error: ${problem.message}`;
  return null;
}

// ── cache ─────────────────────────────────────────────────────────────
// One file per tenant: <host>_<tenant>.json. Both parts are already
// restricted (tenantFromUrl), the replace is a second guard for the path.
function cacheFileName(origin, tenant) {
  const host = new URL(origin).hostname;
  return `${host}_${tenant}.json`.replace(/[^A-Za-z0-9_.-]/g, '_');
}

// An entry is { at: <ms since epoch>, value }. Older than maxAge, from the
// future, or malformed → not fresh.
function entryFresh(entry, now, maxAgeMs) {
  if (
    !entry ||
    typeof entry !== 'object' ||
    !Number.isFinite(entry.at) ||
    entry.value === undefined
  )
    return false;
  const age = now - entry.at;
  return age >= 0 && age <= maxAgeMs;
}

// ── lookup input ──────────────────────────────────────────────────────
// Plain text: one name per line. JSON: an array of objects with a `name`.
// Returns { items: [{ name, source }] } or { error }.
function parseLookupInput(text, asJson) {
  if (asJson) {
    let data;
    try {
      data = JSON.parse(text);
    } catch (_) {
      return { error: 'stdin is not valid JSON; expected an array of objects with a "name" field' };
    }
    if (!Array.isArray(data))
      return { error: 'stdin JSON must be an array of objects with a "name" field' };
    const bad = data.findIndex(
      (o) =>
        !o ||
        typeof o !== 'object' ||
        Array.isArray(o) ||
        typeof o.name !== 'string' ||
        !clean(o.name)
    );
    if (bad >= 0) return { error: `item ${bad} has no "name" string` };
    return { items: data.map((o) => ({ name: clean(o.name), source: o })) };
  }
  const items = String(text)
    .split(/\r?\n/)
    .map(clean)
    .filter(Boolean)
    .map((name) => ({ name, source: null }));
  return { items };
}

// A name → one lookup result. `people` is the search result, `profile` the
// profile of the chosen person (or null when Workday has none).
function lookupResult(name, people, profile) {
  const pick = choosePerson(name, people);
  if (!pick.person) {
    const cands = (pick.candidates || []).map((p) => ({
      id: p.id,
      name: p.name,
      title: p.title,
      org: p.org,
    }));
    return { status: cands.length ? 'ambiguous' : 'not-found', candidates: cands };
  }
  const p = pick.person;
  if (!profile)
    return {
      status: 'no-profile',
      id: p.id,
      name: p.name,
      title: p.title,
      org: p.org,
      location: p.location,
    };
  return {
    status: 'found',
    id: p.id,
    name: p.name,
    title: profile.title || p.title,
    org: p.org || (profile.orgPath.length ? profile.orgPath[profile.orgPath.length - 1] : ''),
    location: profile.location || p.location,
    manager: profile.managers.map((m) => m.name).join(', '),
    managerId: profile.managers.map((m) => m.id).join(', '),
  };
}

// ── tree ──────────────────────────────────────────────────────────────
// Breadth-first walk of an org. `load(orgId)` returns the parsed org with
// every member (see loadOrg in workday.jsh). Each person appears once, with
// the top-level group: the direct report of the root whose sub-org holds
// them. A direct report of the root heads their own group. The root's owner
// has group null. maxDepth: expand orgs at most this many levels down.
async function walkTree(rootOrgId, load, { maxDepth = Infinity } = {}) {
  const people = new Map();
  const warnings = [];
  const seenOrgs = new Set([rootOrgId]);
  const queue = [{ orgId: rootOrgId, depth: 0, group: null }];
  let root = null;
  const add = (p) => {
    if (p.id && !people.has(p.id)) people.set(p.id, p);
  };
  while (queue.length) {
    const { orgId, depth, group } = queue.shift();
    const nav = await load(orgId);
    if (!nav) throw new Error(`no org chart for ${orgId}`);
    if (nav.incomplete)
      warnings.push(`${orgId}: listed ${nav.children.length} of ${nav.total} members`);
    const orgName = (nav.self && nav.self.name) || orgId;
    if (depth === 0) {
      root = { id: orgId, name: orgName, owners: (nav.self && nav.self.owners) || [] };
      for (const o of root.owners) {
        add({
          id: o.id,
          name: o.name,
          title: (nav.self && nav.self.title) || '',
          location: (nav.self && nav.self.location) || '',
          org: orgName,
          group: null,
          groupId: null,
          depth: 0,
        });
      }
    }
    for (const c of nav.children) {
      if (c.kind === 'person') {
        const g = depth === 0 ? { id: c.id, name: c.name } : group;
        add({
          id: c.id,
          name: c.name,
          title: c.title,
          location: c.location,
          org: orgName,
          group: g.name,
          groupId: g.id,
          depth: depth + 1,
        });
        continue;
      }
      const lead = c.owners[0] || { id: c.id, name: c.name };
      const g = depth === 0 ? lead : group;
      for (const o of c.owners) {
        const own = depth === 0 ? o : group;
        add({
          id: o.id,
          name: o.name,
          title: c.title,
          location: c.location,
          org: orgName,
          group: own.name,
          groupId: own.id,
          depth: depth + 1,
        });
      }
      if (!seenOrgs.has(c.id) && depth + 1 < maxDepth) {
        seenOrgs.add(c.id);
        queue.push({ orgId: c.id, depth: depth + 1, group: g });
      }
    }
  }
  return { root, people: [...people.values()], warnings };
}

module.exports = {
  isRateLimited,
  parseDuration,
  sleep,
  now,
  requestId,
  parseKeepalive,
  keepaliveInterval,
  sessionGone,
  cacheFileName,
  entryFresh,
  parseLookupInput,
  lookupResult,
  walkTree,
  INSTANCE_ID,
  SERVER_PATH,
  tenantFromUrl,
  workdayError,
  currentUser,
  searchPeople,
  choosePerson,
  parseProfile,
  parseTeamPage,
  parseNavigator,
  parseChunk,
  chainOf,
};
