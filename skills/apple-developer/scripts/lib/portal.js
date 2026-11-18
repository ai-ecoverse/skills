// portal.js — Apple Developer portal (Certificates, Identifiers & Profiles) API helpers.
//
// The portal's web app talks to a JSON:API backend under
// https://developer.apple.com/services-account/v1/, which mirrors the App Store
// Connect API's provisioning resources (bundleIds, bundleIdCapabilities,
// certificates, profiles, capabilities). It is the web app's own backend, so
// every call runs inside a logged-in developer.apple.com tab (cookies + origin).
//
// Two quirks, both read from the portal's own bundle (main.*.js) and confirmed
// against the live API (see references/endpoints.md):
//  - Reads are POSTs with `X-HTTP-Method-Override: GET` and a body of
//    {urlEncodedQueryParams, teamId}. A plain GET answers 403 "Please select a team".
//  - Writes need the `csrf` and `csrf_ts` headers. The portal reads them from the
//    response headers of any API call; without them a write answers 421.
//
// Everything here is pure (no sliccy: modules) so tests run under plain node.

const API = '/services-account/v1/';
const ORIGIN = 'https://developer.apple.com';
const TEAM_RE = /^[A-Z0-9]{10}$/;
const RESOURCE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const BUNDLE_ID_RE = /^[A-Za-z0-9.-]+(\.\*)?$/;
const CAPABILITY_RE = /^[A-Z0-9_]{2,64}$/;

// Runs IN THE PAGE, via browser.evalAsync(tab, `(${pageRequest})(${JSON.stringify(req)})`).
// Must be self-contained: no closures over module scope. Returns plain data;
// the host parses `text`.
async function pageRequest(req) {
  const api = '/services-account/v1/';
  const base = { 'content-type': 'application/vnd.api+json', 'x-requested-with': 'XMLHttpRequest' };
  const read = (path, query) =>
    fetch(api + path, {
      method: 'POST',
      credentials: 'include',
      headers: Object.assign({}, base, { 'x-http-method-override': 'GET' }),
      body: JSON.stringify({ urlEncodedQueryParams: query || '', teamId: req.teamId }),
    });
  let res;
  if (req.kind === 'teams') {
    res = await fetch('/services-account/QH65B2/account/listTeams.action', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-requested-with': 'XMLHttpRequest',
      },
      body: '',
    });
  } else if (req.method === 'GET') {
    res = await read(req.path, req.query);
  } else {
    // Any read hands out the CSRF pair the portal expects on writes.
    const prime = await read('certificates', 'limit=1');
    const csrf = prime.headers.get('csrf');
    const csrfTs = prime.headers.get('csrf_ts');
    if (!prime.ok || !csrf || !csrfTs) {
      return { status: prime.status, text: await prime.text(), error: 'csrf' };
    }
    res = await fetch(api + req.path, {
      method: req.method,
      credentials: 'include',
      headers: Object.assign({}, base, { csrf: csrf, csrf_ts: csrfTs }),
      body: JSON.stringify(req.body),
    });
  }
  return { status: res.status, text: await res.text(), url: res.url };
}

function query(params) {
  // Apple expects literal brackets and commas (filter[platform]=IOS,MACOS); encode values only.
  return Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v)).replace(/%2C/gi, ',')}`)
    .join('&');
}

function readRequest(teamId, path, params) {
  return { kind: 'v1', method: 'GET', teamId, path, query: query(params || {}) };
}

function writeRequest(teamId, method, path, body) {
  return { kind: 'v1', method, teamId, path, body };
}

// Parse a pageRequest result. Returns {ok, status, json, error}. `error` is a
// human message for the CLI; the caller decides whether to die.
function parseResponse(res) {
  const status = res && typeof res.status === 'number' ? res.status : 0;
  const text = res && typeof res.text === 'string' ? res.text : '';
  const trimmed = text.trim();
  if (
    /^<(!doctype|html)/i.test(trimmed) ||
    (res && typeof res.url === 'string' && /idmsa|signin|login/i.test(res.url))
  ) {
    return {
      ok: false,
      status,
      json: null,
      error:
        'not signed in: log in to https://developer.apple.com/account in your browser, then retry',
    };
  }
  let json = null;
  if (trimmed) {
    try {
      json = JSON.parse(trimmed);
    } catch {
      json = null;
    }
  }
  if (res && res.error === 'csrf') {
    return {
      ok: false,
      status,
      json,
      error: `the portal gave no CSRF token (HTTP ${status}); reload developer.apple.com/account in your browser and retry`,
    };
  }
  if (status === 401)
    return {
      ok: false,
      status,
      json,
      error:
        'session expired: log in to https://developer.apple.com/account in your browser, then retry',
    };
  if (status >= 200 && status < 300) return { ok: true, status, json, error: null };
  const detail = describeErrors(json);
  if (status === 403 && /select a team/i.test(detail)) {
    return {
      ok: false,
      status,
      json,
      error: 'the portal refused the team: pass --team <TEAMID> (see `apple-developer teams`)',
    };
  }
  if (status === 421)
    return {
      ok: false,
      status,
      json,
      error: 'the portal refused the write without a CSRF token (HTTP 421)',
    };
  return {
    ok: false,
    status,
    json,
    error: detail ? `HTTP ${status}: ${detail}` : `HTTP ${status}`,
  };
}

function describeErrors(json) {
  const errors = json && Array.isArray(json.errors) ? json.errors : [];
  return errors.map((e) => [e.code, e.detail || e.title].filter(Boolean).join(': ')).join('; ');
}

// ── teams ──────────────────────────────────────────────────────────────────
function teamsFrom(json) {
  const teams = json && Array.isArray(json.teams) ? json.teams : [];
  return teams.map((t) => ({ teamId: t.teamId, name: t.name, type: t.type, status: t.status }));
}

// --team wins, then APPLE_TEAM_ID, then the only active team. Never a built-in default.
function chooseTeam(flagTeam, envTeam, teams) {
  const explicit = flagTeam || envTeam;
  if (explicit) {
    if (!TEAM_RE.test(explicit)) return { error: `not a team ID: ${explicit}` };
    if (teams && teams.length && !teams.some((t) => t.teamId === explicit)) {
      return { error: `you are not a member of team ${explicit}` };
    }
    return { teamId: explicit };
  }
  const active = (teams || []).filter((t) => !t.status || t.status === 'active');
  if (active.length === 1) return { teamId: active[0].teamId };
  if (!active.length) return { error: 'this Apple ID has no active developer team' };
  return {
    error: `you belong to ${active.length} teams; pass --team <TEAMID> (one of ${active.map((t) => t.teamId).join(', ')})`,
  };
}

// ── resources ──────────────────────────────────────────────────────────────
function rows(json) {
  return json && Array.isArray(json.data) ? json.data : json && json.data ? [json.data] : [];
}

function included(json, type) {
  return (json && Array.isArray(json.included) ? json.included : []).filter(
    (i) => !type || i.type === type
  );
}

function certificateRow(c) {
  const a = c.attributes || {};
  return {
    id: c.id,
    type: a.certificateType,
    name: a.name,
    serial: a.serialNumber,
    platform: a.platform,
    expires: a.expirationDate,
  };
}

function bundleIdRow(b) {
  const a = b.attributes || {};
  return {
    id: b.id,
    identifier: a.identifier,
    name: a.name,
    platform: a.platform,
    seedId: a.seedId,
  };
}

function capabilityRows(json, bundleRowId) {
  return included(json, 'bundleIdCapabilities')
    .filter((c) => !bundleRowId || c.id.startsWith(`${bundleRowId}_`))
    .map((c) => ({
      capability: bundleRowId ? c.id.slice(bundleRowId.length + 1) : c.id,
      enabled: c.attributes ? c.attributes.enabled !== false : true,
      settings: (c.attributes && Array.isArray(c.attributes.settings)
        ? c.attributes.settings
        : []
      ).map((s) => `${s.key}=${(s.options || []).map((o) => o.key).join('|')}`),
    }));
}

function profileRow(p) {
  const a = p.attributes || {};
  return {
    id: p.id,
    name: a.name,
    type: a.profileType,
    state: a.profileState,
    platform: a.platform,
    uuid: a.uuid,
    expires: a.expirationDate,
  };
}

// A name, a 10-char resource ID, or a UUID picks exactly one profile.
function pickProfile(profiles, ref) {
  const byId = profiles.filter((p) => p.id === ref || (p.attributes && p.attributes.uuid === ref));
  if (byId.length === 1) return { profile: byId[0] };
  const byName = profiles.filter((p) => p.attributes && p.attributes.name === ref);
  if (byName.length === 1) return { profile: byName[0] };
  if (byName.length > 1)
    return {
      error: `${byName.length} profiles are named "${ref}"; use the ID (${byName.map((p) => p.id).join(', ')})`,
    };
  return { error: `no profile matches "${ref}"` };
}

// profileContent is the signed .provisionprofile (CMS), base64. Reject anything else.
function profileBytes(profile) {
  const b64 = profile && profile.attributes && profile.attributes.profileContent;
  if (typeof b64 !== 'string' || !/^[A-Za-z0-9+/=\s]+$/.test(b64)) return null;
  const bytes = Buffer.from(b64, 'base64');
  // DER SEQUENCE with a long-form length: every CMS SignedData blob starts 0x30 0x8x.
  if (bytes.length < 64 || bytes[0] !== 0x30 || (bytes[1] & 0x80) === 0) return null;
  return bytes;
}

// ── write bodies (shapes from the portal's own submit handlers) ──────────────
function bundleIdCreateBody({ teamId, identifier, name, capabilities }) {
  if (!TEAM_RE.test(teamId || '')) throw new Error('a team ID is required');
  if (!BUNDLE_ID_RE.test(identifier || ''))
    throw new Error(`not a bundle identifier: ${identifier}`);
  if (!name || /[@&*"]/.test(name))
    throw new Error('--name is required and may not contain @ & * "');
  const caps = (capabilities || []).map((cap) => {
    if (!CAPABILITY_RE.test(cap))
      throw new Error(`not a capability ID: ${cap} (see \`apple-developer capabilities\`)`);
    return {
      type: 'bundleIdCapabilities',
      attributes: { enabled: true, settings: [] },
      relationships: { capability: { data: { type: 'capabilities', id: cap } } },
    };
  });
  return {
    data: {
      type: 'bundleIds',
      attributes: { identifier, seedId: teamId, teamId, name },
      relationships: { bundleIdCapabilities: { data: caps } },
    },
  };
}

const PROFILE_TYPES = [
  'MAC_APP_DIRECT',
  'MAC_APP_DEVELOPMENT',
  'MAC_APP_STORE',
  'IOS_APP_DEVELOPMENT',
  'IOS_APP_ADHOC',
  'IOS_APP_STORE',
  'TVOS_APP_DEVELOPMENT',
  'TVOS_APP_ADHOC',
  'TVOS_APP_STORE',
  'MAC_CATALYST_APP_DIRECT',
  'MAC_CATALYST_APP_DEVELOPMENT',
  'MAC_CATALYST_APP_STORE',
];

function profileCreateBody({ teamId, name, profileType, bundleIdId, certificateIds }) {
  if (!TEAM_RE.test(teamId || '')) throw new Error('a team ID is required');
  if (!name) throw new Error('--name is required');
  if (!PROFILE_TYPES.includes(profileType))
    throw new Error(`--type must be one of ${PROFILE_TYPES.join(', ')}`);
  if (!RESOURCE_ID_RE.test(bundleIdId || '')) throw new Error('a bundle ID resource is required');
  if (
    !certificateIds ||
    !certificateIds.length ||
    !certificateIds.every((c) => RESOURCE_ID_RE.test(c))
  ) {
    throw new Error('at least one certificate is required');
  }
  return {
    data: {
      type: 'profiles',
      attributes: { name, profileType, teamId },
      relationships: {
        bundleId: { data: { type: 'bundleIds', id: bundleIdId } },
        certificates: { data: certificateIds.map((id) => ({ type: 'certificates', id })) },
      },
    },
  };
}

// A certificate is chosen by resource ID or serial number, never by "the newest one".
function pickCertificates(certs, refs) {
  const out = [];
  for (const ref of refs) {
    const hit = certs.filter(
      (c) =>
        c.id === ref ||
        (c.attributes &&
          String(c.attributes.serialNumber).toUpperCase() === String(ref).toUpperCase())
    );
    if (hit.length !== 1)
      return {
        error: `no single certificate matches "${ref}" (use an ID or serial from \`apple-developer certs\`)`,
      };
    out.push(hit[0]);
  }
  return { certificates: out };
}

module.exports = {
  API,
  ORIGIN,
  PROFILE_TYPES,
  pageRequest,
  query,
  readRequest,
  writeRequest,
  parseResponse,
  describeErrors,
  teamsFrom,
  chooseTeam,
  rows,
  included,
  certificateRow,
  bundleIdRow,
  capabilityRows,
  profileRow,
  pickProfile,
  profileBytes,
  bundleIdCreateBody,
  profileCreateBody,
  pickCertificates,
};
